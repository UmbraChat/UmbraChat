use std::future::Future;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use libsignal_protocol::{
    kem, message_decrypt, message_encrypt, process_prekey_bundle, CiphertextMessage, DeviceId,
    GenericSignedPreKey, IdentityKey, IdentityKeyPair, IdentityKeyStore, InMemSignalProtocolStore,
    KeyPair, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyId,
    PreKeyRecord, PreKeyStore, PreKeySignalMessage, PrivateKey, ProtocolAddress, PublicKey,
    SessionRecord, SessionStore, SignalMessage, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore, Timestamp,
};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// libsignal's store traits are `async fn` for API flexibility, but the
/// in-memory stores used here never actually suspend - they resolve on the
/// first poll. Driving them this way avoids wasm-bindgen's async-method
/// machinery entirely for what is, in practice, synchronous work.
fn block_on<F: Future>(future: F) -> F::Output {
    fn no_op(_: *const ()) {}
    fn clone_waker(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone_waker, no_op, no_op, no_op);
    let raw_waker = RawWaker::new(std::ptr::null(), &VTABLE);
    let waker = unsafe { Waker::from_raw(raw_waker) };
    let mut cx = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(val) => val,
        Poll::Pending => panic!("libsignal in-memory store future did not resolve synchronously"),
    }
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// `std::time::SystemTime::now()` panics on bare wasm32-unknown-unknown (no OS
/// clock). libsignal's functions take `std::time::SystemTime` specifically, so
/// we can't just swap in `web_time::SystemTime` (a distinct type) - instead,
/// read the real clock via `web_time` (bridges to `Date.now()`) and rebuild a
/// `std::time::SystemTime` from its millisecond offset, which needs no clock.
fn now() -> SystemTime {
    let millis = web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .expect("system clock should be after the unix epoch")
        .as_millis();
    UNIX_EPOCH + Duration::from_millis(millis as u64)
}

/// device_id is always 1: multi-device is a separate, later story.
fn address(id: &str) -> ProtocolAddress {
    ProtocolAddress::new(id.to_string(), DeviceId::try_from(1u32).expect("1 is a valid device id"))
}

#[derive(Deserialize)]
struct SignedPrekeyIn {
    key_id: u32,
    public_key: Vec<u8>,
    private_key: Vec<u8>,
    signature: Vec<u8>,
}

#[derive(Deserialize)]
struct PrekeyIn {
    key_id: u32,
    public_key: Vec<u8>,
    private_key: Vec<u8>,
}

#[derive(Deserialize)]
struct LocalIdentity {
    identity_public_key: Vec<u8>,
    identity_private_key: Vec<u8>,
    registration_id: u32,
    signed_prekey: SignedPrekeyIn,
    kyber_signed_prekey: SignedPrekeyIn,
    one_time_prekeys: Vec<PrekeyIn>,
}

#[derive(Deserialize)]
struct PublicSignedPrekeyIn {
    key_id: u32,
    public_key: Vec<u8>,
    signature: Vec<u8>,
}

#[derive(Deserialize)]
struct PublicPrekeyIn {
    key_id: u32,
    public_key: Vec<u8>,
}

#[derive(Deserialize)]
struct ContactBundle {
    identity_public_key: Vec<u8>,
    registration_id: u32,
    signed_prekey: PublicSignedPrekeyIn,
    kyber_signed_prekey: PublicSignedPrekeyIn,
    one_time_prekey: Option<PublicPrekeyIn>,
}

#[wasm_bindgen]
pub struct SignalStore {
    inner: InMemSignalProtocolStore,
}

#[wasm_bindgen]
impl SignalStore {
    /// Rebuilds a fully-populated store (identity plus this device's own
    /// prekeys, so an incoming first message can be processed) from the exact
    /// bundle `generate_identity_bundle` produced.
    #[wasm_bindgen(constructor)]
    pub fn new(local_identity: JsValue) -> Result<SignalStore, JsValue> {
        let local: LocalIdentity = serde_wasm_bindgen::from_value(local_identity).map_err(js_err)?;

        let identity_key = IdentityKey::decode(&local.identity_public_key).map_err(js_err)?;
        let private_key = PrivateKey::deserialize(&local.identity_private_key).map_err(js_err)?;
        let identity_key_pair = IdentityKeyPair::new(identity_key, private_key);

        let mut inner = InMemSignalProtocolStore::new(identity_key_pair, local.registration_id).map_err(js_err)?;

        // ponytail: record timestamp is a placeholder (0), not the real registration
        // time - this bundle doesn't carry one, and nothing here reads it yet. Track
        // the real value once prekey rotation/expiry policy needs to compare ages.
        let signed_key_pair =
            KeyPair::from_public_and_private(&local.signed_prekey.public_key, &local.signed_prekey.private_key).map_err(js_err)?;
        let signed_id = SignedPreKeyId::from(local.signed_prekey.key_id);
        let signed_record = SignedPreKeyRecord::new(signed_id, Timestamp::from_epoch_millis(0), &signed_key_pair, &local.signed_prekey.signature);
        block_on(inner.signed_pre_key_store.save_signed_pre_key(signed_id, &signed_record)).map_err(js_err)?;

        let kyber_key_pair = kem::KeyPair::from_public_and_private(&local.kyber_signed_prekey.public_key, &local.kyber_signed_prekey.private_key)
            .map_err(js_err)?;
        let kyber_id = KyberPreKeyId::from(local.kyber_signed_prekey.key_id);
        let kyber_record = KyberPreKeyRecord::new(kyber_id, Timestamp::from_epoch_millis(0), &kyber_key_pair, &local.kyber_signed_prekey.signature);
        block_on(inner.kyber_pre_key_store.save_kyber_pre_key(kyber_id, &kyber_record)).map_err(js_err)?;

        for prekey in &local.one_time_prekeys {
            let key_pair = KeyPair::from_public_and_private(&prekey.public_key, &prekey.private_key).map_err(js_err)?;
            let id = PreKeyId::from(prekey.key_id);
            let record = PreKeyRecord::new(id, &key_pair);
            block_on(inner.pre_key_store.save_pre_key(id, &record)).map_err(js_err)?;
        }

        Ok(SignalStore { inner })
    }

    /// X3DH/PQXDH: establishes a session with `contact_id` from their prekey bundle.
    pub fn establish_session(&mut self, contact_id: String, bundle: JsValue) -> Result<(), JsValue> {
        let bundle: ContactBundle = serde_wasm_bindgen::from_value(bundle).map_err(js_err)?;

        let identity_key = IdentityKey::decode(&bundle.identity_public_key).map_err(js_err)?;
        let signed_prekey_public = PublicKey::deserialize(&bundle.signed_prekey.public_key).map_err(js_err)?;
        let kyber_prekey_public = kem::PublicKey::deserialize(&bundle.kyber_signed_prekey.public_key).map_err(js_err)?;

        let one_time = match &bundle.one_time_prekey {
            Some(k) => Some((PreKeyId::from(k.key_id), PublicKey::deserialize(&k.public_key).map_err(js_err)?)),
            None => None,
        };

        let prekey_bundle = PreKeyBundle::new(
            bundle.registration_id,
            DeviceId::try_from(1u32).expect("1 is a valid device id"),
            one_time,
            SignedPreKeyId::from(bundle.signed_prekey.key_id),
            signed_prekey_public,
            bundle.signed_prekey.signature.clone(),
            KyberPreKeyId::from(bundle.kyber_signed_prekey.key_id),
            kyber_prekey_public,
            bundle.kyber_signed_prekey.signature.clone(),
            identity_key,
        )
        .map_err(js_err)?;

        let remote = address(&contact_id);
        let local = address("self");
        let mut rng = rand::rng();

        block_on(process_prekey_bundle(
            &remote,
            &local,
            &mut self.inner.session_store,
            &mut self.inner.identity_store,
            &prekey_bundle,
            now(),
            &mut rng,
        ))
        .map_err(js_err)
    }

    pub fn has_session(&self, contact_id: String) -> Result<bool, JsValue> {
        let remote = address(&contact_id);
        let session = block_on(self.inner.session_store.load_session(&remote)).map_err(js_err)?;
        Ok(session.is_some())
    }

    /// Serializes the session with `contact_id`, if one exists, so the caller
    /// can persist it (e.g. to IndexedDB) and restore it on the next page
    /// load - a session's ratchet state changes on every encrypt/decrypt, so
    /// this should be called again after each one.
    pub fn export_session(&self, contact_id: String) -> Result<Option<Vec<u8>>, JsValue> {
        let remote = address(&contact_id);
        let session = block_on(self.inner.session_store.load_session(&remote)).map_err(js_err)?;
        session.map(|s| s.serialize().map_err(js_err)).transpose()
    }

    /// Restores a session previously returned by `export_session`.
    pub fn import_session(&mut self, contact_id: String, bytes: Vec<u8>) -> Result<(), JsValue> {
        let remote = address(&contact_id);
        let record = SessionRecord::deserialize(&bytes).map_err(js_err)?;
        block_on(self.inner.session_store.store_session(&remote, &record)).map_err(js_err)?;
        // The store is rebuilt from scratch on every page load, so a restored session must
        // also re-pin its peer's identity: libsignal then refuses a different key for this
        // address instead of silently trusting it as a first contact.
        if let Some(key) = record.remote_identity_key_bytes().map_err(js_err)? {
            let identity = IdentityKey::decode(&key).map_err(js_err)?;
            block_on(self.inner.identity_store.save_identity(&remote, &identity)).map_err(js_err)?;
        }
        Ok(())
    }

    /// Pins `identity` (a key the user compared out of band) for `contact_id`, replacing any
    /// previous pin, so the next session with that address is accepted with exactly this key.
    pub fn trust_peer_identity(&mut self, contact_id: String, identity: Vec<u8>) -> Result<(), JsValue> {
        let identity = IdentityKey::decode(&identity).map_err(js_err)?;
        block_on(self.inner.identity_store.save_identity(&address(&contact_id), &identity)).map_err(js_err)?;
        Ok(())
    }

    /// The identity key currently pinned for `contact_id` (from an established or restored
    /// session), for showing a fingerprint to compare out of band.
    pub fn peer_identity(&self, contact_id: String) -> Result<Option<Vec<u8>>, JsValue> {
        let remote = address(&contact_id);
        let key = block_on(self.inner.identity_store.get_identity(&remote)).map_err(js_err)?;
        Ok(key.map(|k| k.serialize().to_vec()))
    }

    /// Double Ratchet encrypt. The returned bytes are prefixed with a single
    /// message-type byte (2 = ongoing session, 3 = first message / carries
    /// prekey material) so the recipient's `decrypt` can dispatch correctly.
    pub fn encrypt(&mut self, contact_id: String, plaintext: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let remote = address(&contact_id);
        let local = address("self");
        let mut rng = rand::rng();

        let message = block_on(message_encrypt(
            &plaintext,
            &remote,
            &local,
            &mut self.inner.session_store,
            &mut self.inner.identity_store,
            now(),
            &mut rng,
        ))
        .map_err(js_err)?;

        let mut out = vec![message.message_type() as u8];
        out.extend_from_slice(message.serialize());
        Ok(out)
    }

    pub fn decrypt(&mut self, contact_id: String, envelope: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let (type_byte, body) = envelope.split_first().ok_or_else(|| js_err("empty envelope"))?;
        let remote = address(&contact_id);
        let local = address("self");
        let mut rng = rand::rng();

        let ciphertext = match *type_byte {
            2 => CiphertextMessage::SignalMessage(SignalMessage::try_from(body).map_err(js_err)?),
            3 => CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(body).map_err(js_err)?),
            other => return Err(js_err(format!("unknown message type byte: {other}"))),
        };

        block_on(message_decrypt(
            &ciphertext,
            &remote,
            &local,
            &mut self.inner.session_store,
            &mut self.inner.identity_store,
            &mut self.inner.pre_key_store,
            &self.inner.signed_pre_key_store,
            &mut self.inner.kyber_pre_key_store,
            &mut rng,
        ))
        .map_err(js_err)
    }
}

/// The sender identity key carried by a first message (type byte 3), without decrypting
/// or trusting it - used to show the fingerprint of a key that was just refused.
#[wasm_bindgen]
pub fn prekey_message_identity(envelope: Vec<u8>) -> Result<Option<Vec<u8>>, JsValue> {
    match envelope.split_first() {
        Some((3, body)) => {
            let message = PreKeySignalMessage::try_from(body).map_err(js_err)?;
            Ok(Some(message.identity_key().serialize().to_vec()))
        }
        _ => Ok(None),
    }
}
