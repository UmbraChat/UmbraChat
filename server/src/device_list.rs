//! Signed device list: the server's reading of the statements clients sign, so it only keeps
//! chains that are valid. Clients never rely on this check (they verify the chain themselves,
//! web/src/crypto/deviceList.ts defines the layout and the rules); it keeps honest clients
//! consistent with what is stored.
//!
//! A statement is signed as exact bytes and never re-encoded:
//!   prefix | account_id(16) | version(u32 BE) | prev_head(32) | signer_device_id(16) | count(u16 BE)
//!          | count x ( device_id(16) | key_len(u8) | identity_key )
//! `head` = SHA-256(statement bytes | signature).

use libsignal_protocol::IdentityKey;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const PREFIX: &[u8] = b"umbrachat-device-list-v1\n";
pub const MAX_DEVICES: usize = 20;
const KEY_LENGTH: usize = 33;
const HEAD_LENGTH: usize = 32;
pub const ZERO_HEAD: [u8; HEAD_LENGTH] = [0; HEAD_LENGTH];

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub device_id: Uuid,
    pub identity_key: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub account_id: Uuid,
    pub version: u32,
    pub prev_head: [u8; HEAD_LENGTH],
    pub signer: Uuid,
    pub devices: Vec<Entry>,
}

/// Where a chain stands after its latest statement.
#[derive(Clone, Debug)]
pub struct Chain {
    pub account_id: Uuid,
    pub version: u32,
    pub head: [u8; HEAD_LENGTH],
    pub devices: Vec<Entry>,
}

pub fn encode(s: &Statement) -> Vec<u8> {
    let mut out = PREFIX.to_vec();
    out.extend_from_slice(s.account_id.as_bytes());
    out.extend_from_slice(&s.version.to_be_bytes());
    out.extend_from_slice(&s.prev_head);
    out.extend_from_slice(s.signer.as_bytes());
    out.extend_from_slice(&(s.devices.len() as u16).to_be_bytes());
    for d in &s.devices {
        out.extend_from_slice(d.device_id.as_bytes());
        out.push(d.identity_key.len() as u8);
        out.extend_from_slice(&d.identity_key);
    }
    out
}

/// Strict: any deviation from the layout is an error.
pub fn decode(bytes: &[u8]) -> Result<Statement, &'static str> {
    let mut at = 0usize;
    let mut take = |n: usize| -> Result<&[u8], &'static str> {
        let end = at.checked_add(n).filter(|end| *end <= bytes.len()).ok_or("statement is truncated")?;
        let slice = &bytes[at..end];
        at = end;
        Ok(slice)
    };
    if take(PREFIX.len())? != PREFIX {
        return Err("not a device list statement");
    }
    let uuid = |b: &[u8]| Uuid::from_slice(b).map_err(|_| "bad uuid");
    let account_id = uuid(take(16)?)?;
    let version = u32::from_be_bytes(take(4)?.try_into().unwrap());
    let prev_head: [u8; HEAD_LENGTH] = take(HEAD_LENGTH)?.try_into().unwrap();
    let signer = uuid(take(16)?)?;
    let count = u16::from_be_bytes(take(2)?.try_into().unwrap()) as usize;
    if count == 0 || count > MAX_DEVICES {
        return Err("bad device count");
    }
    let mut devices = Vec::with_capacity(count);
    for _ in 0..count {
        let device_id = uuid(take(16)?)?;
        if take(1)?[0] as usize != KEY_LENGTH {
            return Err("bad identity key length");
        }
        devices.push(Entry { device_id, identity_key: take(KEY_LENGTH)?.to_vec() });
    }
    if at != bytes.len() {
        return Err("trailing bytes after statement");
    }
    Ok(Statement { account_id, version, prev_head, signer, devices })
}

pub fn head_of(bytes: &[u8], signature: &[u8]) -> [u8; HEAD_LENGTH] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.update(signature);
    hasher.finalize().into()
}

/// Checks that (`bytes`, `signature`) validly continues `prev` (or starts a chain when `prev`
/// is `None`) and returns the new state. The signer's key is taken from the previous list, never
/// from the statement itself, except at the genesis where its only device vouches for itself.
pub fn verify_next(prev: Option<&Chain>, bytes: &[u8], signature: &[u8]) -> Result<Chain, &'static str> {
    let s = decode(bytes)?;
    let expected_version = prev.map_or(1, |p| p.version + 1);
    if s.version != expected_version {
        return Err("unexpected version");
    }
    if let Some(p) = prev {
        if s.account_id != p.account_id {
            return Err("statement belongs to another account");
        }
        if s.prev_head != p.head {
            return Err("statement does not follow the current head");
        }
    } else {
        if s.prev_head != ZERO_HEAD {
            return Err("genesis must have an empty previous head");
        }
        if s.devices.len() != 1 {
            return Err("genesis lists exactly one device");
        }
    }
    let mut ids: Vec<Uuid> = s.devices.iter().map(|d| d.device_id).collect();
    ids.sort();
    ids.dedup();
    if ids.len() != s.devices.len() {
        return Err("duplicate device");
    }

    let trusted = prev.map_or(&s.devices, |p| &p.devices);
    let signer = trusted.iter().find(|d| d.device_id == s.signer).ok_or("signer was not in the previous list")?;
    let key = IdentityKey::decode(&signer.identity_key).map_err(|_| "signer key is not valid")?;
    if !key.public_key().verify_signature(bytes, signature) {
        return Err("signature does not verify");
    }

    if let Some(p) = prev {
        for d in &s.devices {
            if p.devices.iter().any(|before| before.device_id == d.device_id && before.identity_key != d.identity_key) {
                return Err("a device's key cannot change");
            }
        }
    }
    Ok(Chain { account_id: s.account_id, version: s.version, head: head_of(bytes, signature), devices: s.devices })
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsignal_protocol::IdentityKeyPair;

    struct Dev {
        id: Uuid,
        pair: IdentityKeyPair,
    }

    fn dev() -> Dev {
        Dev { id: Uuid::new_v4(), pair: IdentityKeyPair::generate(&mut rand::rng()) }
    }

    fn entry(d: &Dev) -> Entry {
        Entry { device_id: d.id, identity_key: d.pair.identity_key().serialize().to_vec() }
    }

    fn sign(account: Uuid, prev: Option<&Chain>, devices: &[&Dev], signer: &Dev) -> (Vec<u8>, Vec<u8>) {
        let s = Statement {
            account_id: account,
            version: prev.map_or(1, |p| p.version + 1),
            prev_head: prev.map_or(ZERO_HEAD, |p| p.head),
            signer: signer.id,
            devices: devices.iter().map(|d| entry(d)).collect(),
        };
        let bytes = encode(&s);
        let signature = signer.pair.private_key().calculate_signature(&bytes, &mut rand::rng()).unwrap().to_vec();
        (bytes, signature)
    }

    #[test]
    fn a_chain_of_valid_statements_verifies_and_hostile_ones_do_not() {
        let (a, b, x) = (dev(), dev(), dev());
        let account = Uuid::new_v4();

        let (bytes, sig) = sign(account, None, &[&a], &a);
        let c1 = verify_next(None, &bytes, &sig).expect("genesis");

        let (bytes, sig) = sign(account, Some(&c1), &[&a, &b], &a);
        let c2 = verify_next(Some(&c1), &bytes, &sig).expect("add");
        assert_eq!(c2.devices.len(), 2);

        // Removal by the other device, then the removed one can no longer sign.
        let (bytes, sig) = sign(account, Some(&c2), &[&b], &b);
        let c3 = verify_next(Some(&c2), &bytes, &sig).expect("remove");
        let (bytes, sig) = sign(account, Some(&c3), &[&a, &b], &a);
        assert_eq!(verify_next(Some(&c3), &bytes, &sig).unwrap_err(), "signer was not in the previous list");

        let (bytes, sig) = sign(account, Some(&c1), &[&a, &x], &x);
        assert_eq!(verify_next(Some(&c1), &bytes, &sig).unwrap_err(), "signer was not in the previous list");

        let (bytes, sig) = sign(account, Some(&c1), &[&a, &b], &a);
        assert_eq!(verify_next(Some(&c2), &bytes, &sig).unwrap_err(), "unexpected version");
        assert_eq!(verify_next(None, &bytes, &sig).unwrap_err(), "unexpected version");

        let (bytes, sig) = sign(Uuid::new_v4(), Some(&c1), &[&a, &b], &a);
        assert_eq!(verify_next(Some(&c1), &bytes, &sig).unwrap_err(), "statement belongs to another account");

        let (mut bytes, sig) = sign(account, Some(&c1), &[&a, &b], &a);
        let last = bytes.len() - 3;
        bytes[last] ^= 1;
        assert_eq!(verify_next(Some(&c1), &bytes, &sig).unwrap_err(), "signature does not verify");

        let (bytes, sig) = sign(account, Some(&c1), &[&a, &b], &a);
        assert_eq!(decode(&bytes[1..]).unwrap_err(), "not a device list statement");
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(decode(&trailing).unwrap_err(), "trailing bytes after statement");
        assert_eq!(decode(&bytes[..bytes.len() - 1]).unwrap_err(), "statement is truncated");
        let _ = sig;

        // A staying device cannot get a different key.
        let swapped = Dev { id: b.id, pair: IdentityKeyPair::generate(&mut rand::rng()) };
        let (bytes, sig) = sign(account, Some(&c2), &[&a, &swapped], &a);
        assert_eq!(verify_next(Some(&c2), &bytes, &sig).unwrap_err(), "a device's key cannot change");
    }

    #[test]
    fn genesis_rules() {
        let (a, b) = (dev(), dev());
        let account = Uuid::new_v4();
        let (bytes, sig) = sign(account, None, &[&a, &b], &a);
        assert_eq!(verify_next(None, &bytes, &sig).unwrap_err(), "genesis lists exactly one device");
        let (bytes, sig) = sign(account, None, &[&a], &b);
        assert_eq!(verify_next(None, &bytes, &sig).unwrap_err(), "signer was not in the previous list");
    }
}
