use libsignal_protocol::{kem, IdentityKey, IdentityKeyPair, KeyPair, PrivateKey};
use rand::Rng;
use serde::Serialize;
use wasm_bindgen::prelude::*;

mod session;
pub use session::SignalStore;

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
pub struct PrekeyOutput {
    key_id: u32,
    public_key: Vec<u8>,
    private_key: Vec<u8>,
}

#[derive(Serialize)]
pub struct SignedPrekeyOutput {
    key_id: u32,
    public_key: Vec<u8>,
    private_key: Vec<u8>,
    signature: Vec<u8>,
}

#[derive(Serialize)]
pub struct IdentityBundle {
    identity_public_key: Vec<u8>,
    identity_private_key: Vec<u8>,
    registration_id: u32,
    signed_prekey: SignedPrekeyOutput,
    // Post-quantum prekey, mandatory: libsignal-protocol's session establishment
    // uses PQXDH, not classic X3DH, and requires one to build a valid bundle.
    kyber_signed_prekey: SignedPrekeyOutput,
    one_time_prekeys: Vec<PrekeyOutput>,
}

#[derive(Serialize)]
pub struct SignedPrekeyPair {
    signed_prekey: SignedPrekeyOutput,
    kyber_signed_prekey: SignedPrekeyOutput,
}

/// A classic and a post-quantum signed prekey under `key_id`, both signed by `identity`.
fn signed_prekey_pair(identity: &PrivateKey, key_id: u32) -> Result<SignedPrekeyPair, JsValue> {
    let mut rng = rand::rng();

    let signed_prekey_pair = KeyPair::generate(&mut rng);
    let signed_prekey_public = signed_prekey_pair.public_key.serialize();
    let signature = identity
        .calculate_signature(&signed_prekey_public, &mut rng)
        .map_err(|e| JsValue::from_str(&format!("failed to sign prekey: {e}")))?;

    let kyber_prekey_pair = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
    let kyber_prekey_public = kyber_prekey_pair.public_key.serialize();
    let kyber_signature = identity
        .calculate_signature(&kyber_prekey_public, &mut rng)
        .map_err(|e| JsValue::from_str(&format!("failed to sign kyber prekey: {e}")))?;

    Ok(SignedPrekeyPair {
        signed_prekey: SignedPrekeyOutput {
            key_id,
            public_key: signed_prekey_public.to_vec(),
            private_key: signed_prekey_pair.private_key.serialize(),
            signature: signature.to_vec(),
        },
        kyber_signed_prekey: SignedPrekeyOutput {
            key_id,
            public_key: kyber_prekey_public.to_vec(),
            private_key: kyber_prekey_pair.secret_key.serialize().to_vec(),
            signature: kyber_signature.to_vec(),
        },
    })
}

/// A new pair of signed prekeys for rotation, signed by the device's identity key.
#[wasm_bindgen]
pub fn generate_signed_prekeys(identity_private_key: Vec<u8>, key_id: u32) -> Result<JsValue, JsValue> {
    let identity = PrivateKey::deserialize(&identity_private_key).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let pair = signed_prekey_pair(&identity, key_id)?;
    serde_wasm_bindgen::to_value(&pair).map_err(|e| JsValue::from_str(&format!("serialization failed: {e}")))
}

/// Generates a fresh identity key pair, registration id, signed prekey (classic
/// and post-quantum), and a batch of one-time prekeys, all locally. Private key
/// material is included in the result and never leaves this call boundary
/// except into the caller's own device storage.
#[wasm_bindgen]
pub fn generate_identity_bundle(one_time_prekey_count: u32) -> Result<JsValue, JsValue> {
    let mut rng = rand::rng();

    let identity = IdentityKeyPair::generate(&mut rng);
    let registration_id: u32 = rng.random_range(1..16384);
    let SignedPrekeyPair { signed_prekey, kyber_signed_prekey } = signed_prekey_pair(identity.private_key(), 1)?;

    let mut one_time_prekeys = Vec::with_capacity(one_time_prekey_count as usize);
    for key_id in 1..=one_time_prekey_count {
        let pair = KeyPair::generate(&mut rng);
        one_time_prekeys.push(PrekeyOutput {
            key_id,
            public_key: pair.public_key.serialize().to_vec(),
            private_key: pair.private_key.serialize(),
        });
    }

    let bundle = IdentityBundle {
        identity_public_key: identity.identity_key().serialize().to_vec(),
        identity_private_key: identity.private_key().serialize(),
        registration_id,
        signed_prekey,
        kyber_signed_prekey,
        one_time_prekeys,
    };

    serde_wasm_bindgen::to_value(&bundle).map_err(|e| JsValue::from_str(&format!("serialization failed: {e}")))
}

/// Signs arbitrary bytes with an identity private key, for the server's
/// per-request signature auth (method+path+timestamp+body-hash).
#[wasm_bindgen]
pub fn sign_with_identity(identity_private_key: Vec<u8>, message: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    let private_key = PrivateKey::deserialize(&identity_private_key).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut rng = rand::rng();
    let signature = private_key
        .calculate_signature(&message, &mut rng)
        .map_err(|e| JsValue::from_str(&format!("failed to sign: {e}")))?;
    Ok(signature.to_vec())
}

/// Checks a signature made by `sign_with_identity` against a serialized identity public key.
/// A malformed key or signature is simply "not valid", never an error the caller could mistake for success.
#[wasm_bindgen]
pub fn verify_identity_signature(identity_public_key: Vec<u8>, message: Vec<u8>, signature: Vec<u8>) -> bool {
    IdentityKey::decode(&identity_public_key)
        .map(|key| key.public_key().verify_signature(&message, &signature))
        .unwrap_or(false)
}
