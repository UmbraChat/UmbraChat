mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::{app, as_refs, auth_headers, cleanup_account, get_json, like, register_account, request, sign, TestAccount};
use libsignal_protocol::{kem, IdentityKeyPair, KeyPair};
use serde_json::{json, Value};
use umbrachat_server::db;

/// A signed and a Kyber prekey under `key_id`, signed by `signer`.
fn signed_prekeys(signer: &IdentityKeyPair, key_id: i32) -> Value {
    let mut rng = rand::rng();
    let signed = KeyPair::generate(&mut rng).public_key.serialize();
    let kyber = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng).public_key.serialize();
    let signed_signature = signer.private_key().calculate_signature(&signed, &mut rng).unwrap();
    let kyber_signature = signer.private_key().calculate_signature(&kyber, &mut rng).unwrap();
    json!({
        "signed_prekey": { "key_id": key_id, "public_key": STANDARD.encode(&signed), "signature": STANDARD.encode(&signed_signature) },
        "kyber_signed_prekey": { "key_id": key_id, "public_key": STANDARD.encode(&kyber), "signature": STANDARD.encode(&kyber_signature) },
    })
}

async fn rotate(app: &axum::Router, caller: &TestAccount, device_id: uuid::Uuid, body: &Value) -> (axum::http::StatusCode, Value) {
    let path = format!("/v1/devices/{device_id}/signed-prekeys");
    let (ts, sig) = sign(&caller.identity, "POST", &path, body.to_string().as_bytes());
    let headers = auth_headers(caller.device_id, ts, sig);
    request(app, "POST", &path, &as_refs(&headers), body.clone()).await
}

#[tokio::test]
async fn a_device_rotates_its_signed_prekeys_and_the_bundle_serves_the_new_ones() {
    let app = app().await;
    let alice = register_account(&app).await;
    let bob = register_account(&app).await;
    let next = signed_prekeys(&alice.identity, 2);

    let (status, body) = rotate(&app, &alice, alice.device_id, &next).await;
    assert_eq!(status, axum::http::StatusCode::NO_CONTENT, "{body}");
    let (_, bundle) = get_json(&app, &format!("/v1/devices/{}/prekey-bundle", alice.device_id), &like(&bob)).await;
    assert_eq!(bundle["signed_prekey"], next["signed_prekey"]);
    assert_eq!(bundle["kyber_signed_prekey"], next["kyber_signed_prekey"]);

    // A lost answer: the same keys again are accepted and change nothing.
    let (status, _) = rotate(&app, &alice, alice.device_id, &next).await;
    assert_eq!(status, axum::http::StatusCode::NO_CONTENT);

    let pool = db::connect().await;
    cleanup_account(&pool, alice.account_id).await;
    cleanup_account(&pool, bob.account_id).await;
}

#[tokio::test]
async fn a_rotation_that_reuses_an_id_or_is_not_signed_by_the_device_is_refused() {
    let app = app().await;
    let alice = register_account(&app).await;
    let bob = register_account(&app).await;
    let (_, before) = get_json(&app, &format!("/v1/devices/{}/prekey-bundle", alice.device_id), &like(&bob)).await;

    // Another key under the current id (1) or a lower one would give two keys the same id.
    for key_id in [1, 0] {
        let (status, body) = rotate(&app, &alice, alice.device_id, &signed_prekeys(&alice.identity, key_id)).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "key_id {key_id}: {body}");
        assert!(body["error"].as_str().unwrap().contains("higher key_id"), "{body}");
    }

    // Keys signed by someone else.
    let (status, body) = rotate(&app, &alice, alice.device_id, &signed_prekeys(&bob.identity, 2)).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("does not verify"), "{body}");

    // Bob replacing Alice's keys, even with keys Alice's identity signed.
    let (status, _) = rotate(&app, &bob, alice.device_id, &signed_prekeys(&alice.identity, 3)).await;
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

    // No signature at all.
    let path = format!("/v1/devices/{}/signed-prekeys", alice.device_id);
    let (status, _) = request(&app, "POST", &path, &[], signed_prekeys(&alice.identity, 4)).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);

    let (_, after) = get_json(&app, &format!("/v1/devices/{}/prekey-bundle", alice.device_id), &like(&bob)).await;
    assert_eq!(after["signed_prekey"], before["signed_prekey"], "a refused rotation must leave the bundle as it was");
    assert_eq!(after["kyber_signed_prekey"], before["kyber_signed_prekey"]);

    let pool = db::connect().await;
    cleanup_account(&pool, alice.account_id).await;
    cleanup_account(&pool, bob.account_id).await;
}
