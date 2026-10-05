#![allow(dead_code)] // each test binary uses a different part of these helpers
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use libsignal_protocol::{kem, IdentityKeyPair, KeyPair};
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;
use umbrachat_server::protocol::{PROTOCOL_HEADER, PROTOCOL_VERSION};
use umbrachat_server::{db, device_list, routes};
use uuid::Uuid;

// A real, syntactically valid VAPID key so any test that does exercise a
// push send (via a registered subscription) doesn't fail on key parsing -
// its actual value doesn't matter since no test push service is contacted
// during this run.
pub const TEST_VAPID_PRIVATE_KEY: &str = "4rISdCDvPIdiTUpJbPqHt2gi3TCVqEq0sCnqi9iykXQ";

pub async fn app() -> axum::Router {
    let pool = db::connect().await;
    routes::router(pool, TEST_VAPID_PRIVATE_KEY.to_string())
}

pub async fn request(app: &axum::Router, method: &str, path: &str, headers: &[(&str, &str)], body: Value) -> (axum::http::StatusCode, Value) {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(axum::body::Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
    (status, json)
}

/// Signs `METHOD\nPATH\nTIMESTAMP\nSHA256_HEX(BODY)` the same way the real client does,
/// returning the `(X-Timestamp, X-Signature)` header values.
pub fn sign(identity: &IdentityKeyPair, method: &str, path: &str, body: &[u8]) -> (String, String) {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs().to_string();
    let body_hash = hex::encode(Sha256::digest(body));
    let message = format!("{method}\n{path}\n{timestamp}\n{body_hash}");
    let mut rng = rand::rng();
    let signature = identity.private_key().calculate_signature(message.as_bytes(), &mut rng).unwrap();
    (timestamp, STANDARD.encode(signature))
}

pub struct TestAccount {
    pub account_id: Uuid,
    pub device_id: Uuid,
    pub identity: IdentityKeyPair,
    /// Version and head of the account's device list after its latest statement.
    pub chain_version: u32,
    pub chain_head: [u8; 32],
}

/// A signed device-list statement as the request body the server expects.
pub fn signed_statement(account_id: Uuid, version: u32, prev_head: [u8; 32], devices: &[(Uuid, &IdentityKeyPair)], signer: (Uuid, &IdentityKeyPair)) -> (Value, [u8; 32]) {
    let statement = device_list::Statement {
        account_id,
        version,
        prev_head,
        signer: signer.0,
        devices: devices
            .iter()
            .map(|(id, pair)| device_list::Entry { device_id: *id, identity_key: pair.identity_key().serialize().to_vec() })
            .collect(),
    };
    let bytes = device_list::encode(&statement);
    let signature = signer.1.private_key().calculate_signature(&bytes, &mut rand::rng()).unwrap();
    let head = device_list::head_of(&bytes, &signature);
    (json!({ "statement": STANDARD.encode(&bytes), "signature": STANDARD.encode(&signature) }), head)
}

/// A complete, valid /v1/register body for a fresh identity (bundle plus genesis statement).
pub fn register_body(identity: &IdentityKeyPair, account_id: Uuid, device_id: Uuid) -> (Value, [u8; 32]) {
    let mut rng = rand::rng();
    let signed_prekey = KeyPair::generate(&mut rng);
    let one_time_prekey = KeyPair::generate(&mut rng);

    let signed_prekey_public = signed_prekey.public_key.serialize();
    let signature = identity.private_key().calculate_signature(&signed_prekey_public, &mut rng).unwrap();

    let kyber_prekey = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
    let kyber_prekey_public = kyber_prekey.public_key.serialize();
    let kyber_signature = identity.private_key().calculate_signature(&kyber_prekey_public, &mut rng).unwrap();

    let (device_list, head) = signed_statement(account_id, 1, device_list::ZERO_HEAD, &[(device_id, identity)], (device_id, identity));
    let body = json!({
        "account_id": account_id.to_string(),
        "device_id": device_id.to_string(),
        "device_list": device_list,
        "identity_public_key": STANDARD.encode(identity.identity_key().serialize()),
        "registration_id": rng.random_range(1u32..16384),
        "signed_prekey": {
            "key_id": 1,
            "public_key": STANDARD.encode(&signed_prekey_public),
            "signature": STANDARD.encode(&signature),
        },
        "kyber_signed_prekey": {
            "key_id": 1,
            "public_key": STANDARD.encode(&kyber_prekey_public),
            "signature": STANDARD.encode(&kyber_signature),
        },
        "one_time_prekeys": [
            { "key_id": 1, "public_key": STANDARD.encode(one_time_prekey.public_key.serialize()) }
        ],
    });
    (body, head)
}

/// Registers a fresh account through the real /v1/register endpoint, so tests
/// exercise the same path a real client would.
pub async fn register_account(app: &axum::Router) -> TestAccount {
    let identity = IdentityKeyPair::generate(&mut rand::rng());
    let (account_id, device_id) = (Uuid::new_v4(), Uuid::new_v4());
    let (body, head) = register_body(&identity, account_id, device_id);

    let (status, response) = request(app, "POST", "/v1/register", &[], body).await;
    assert_eq!(status, axum::http::StatusCode::CREATED, "test account registration must succeed: {response}");
    assert_eq!(response["account_id"].as_str().unwrap(), account_id.to_string());
    TestAccount { account_id, device_id, identity, chain_version: 1, chain_head: head }
}


pub fn auth_headers(device_id: Uuid, timestamp: String, signature: String) -> Vec<(String, String)> {
    vec![
        ("x-device-id".to_string(), device_id.to_string()),
        ("x-timestamp".to_string(), timestamp),
        ("x-signature".to_string(), signature),
    ]
}

pub fn as_refs(headers: &[(String, String)]) -> Vec<(&str, &str)> {
    headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// A fresh device's registration bundle for a link, with the identity it will sign requests with.
pub fn new_device_bundle() -> (Value, IdentityKeyPair) {
    let mut rng = rand::rng();
    let identity = IdentityKeyPair::generate(&mut rng);
    let signed_prekey = KeyPair::generate(&mut rng);
    let one_time_prekey = KeyPair::generate(&mut rng);
    let kyber_prekey = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);

    let signed_prekey_public = signed_prekey.public_key.serialize();
    let signature = identity.private_key().calculate_signature(&signed_prekey_public, &mut rng).unwrap();
    let kyber_prekey_public = kyber_prekey.public_key.serialize();
    let kyber_signature = identity.private_key().calculate_signature(&kyber_prekey_public, &mut rng).unwrap();

    let bundle = json!({
        "identity_public_key": STANDARD.encode(identity.identity_key().serialize()),
        "registration_id": 2,
        "signed_prekey": { "key_id": 1, "public_key": STANDARD.encode(&signed_prekey_public), "signature": STANDARD.encode(&signature) },
        "kyber_signed_prekey": { "key_id": 1, "public_key": STANDARD.encode(&kyber_prekey_public), "signature": STANDARD.encode(&kyber_signature) },
        "one_time_prekeys": [{ "key_id": 1, "public_key": STANDARD.encode(one_time_prekey.public_key.serialize()) }],
    });
    (bundle, identity)
}

pub async fn get_json(app: &axum::Router, path: &str, caller: &TestAccountLike<'_>) -> (axum::http::StatusCode, Value) {
    // The server signs the path without its query string.
    let (ts, sig) = sign(caller.identity, "GET", path.split('?').next().unwrap(), b"");
    let headers = auth_headers(caller.device_id, ts, sig);
    request(app, "GET", path, &as_refs(&headers), json!(null)).await
}

pub struct TestAccountLike<'a> {
    pub device_id: Uuid,
    pub identity: &'a IdentityKeyPair,
}

pub fn like(a: &TestAccount) -> TestAccountLike<'_> {
    TestAccountLike { device_id: a.device_id, identity: &a.identity }
}

pub async fn link_init(app: &axum::Router, primary: &TestAccount) -> String {
    let path = format!("/v1/accounts/{}/devices/link-init", primary.account_id);
    let (timestamp, signature) = sign(&primary.identity, "POST", &path, b"");
    let headers = auth_headers(primary.device_id, timestamp, signature);
    let (status, body) = request(app, "POST", &path, &as_refs(&headers), json!(null)).await;
    assert_eq!(status, axum::http::StatusCode::OK, "link-init must succeed: {body}");
    body["code"].as_str().unwrap().to_string()
}

/// Registers a new device with a fresh link code: it is pending, nothing more.
pub async fn link_pending(app: &axum::Router, primary: &TestAccount, label: &str) -> (Uuid, IdentityKeyPair) {
    let code = link_init(app, primary).await;
    let (mut bundle, identity) = new_device_bundle();
    bundle["code"] = json!(code);
    bundle["label"] = json!(label);
    let (status, body) = request(app, "POST", &format!("/v1/accounts/{}/devices", primary.account_id), &[], bundle).await;
    assert_eq!(status, axum::http::StatusCode::CREATED, "complete_link must succeed: {body}");
    (body["device_id"].as_str().unwrap().parse().unwrap(), identity)
}

pub async fn submit(app: &axum::Router, account_id: Uuid, caller: &TestAccountLike<'_>, statement: &Value) -> (axum::http::StatusCode, Value) {
    let path = format!("/v1/accounts/{account_id}/device-list");
    let body = statement.to_string();
    let (ts, sig) = sign(caller.identity, "POST", &path, body.as_bytes());
    let headers = auth_headers(caller.device_id, ts, sig);
    request(app, "POST", &path, &as_refs(&headers), statement.clone()).await
}

/// The primary accepts `(device_id, identity)` with a statement it signs (version 2 of its chain).
pub async fn accept(app: &axum::Router, primary: &TestAccount, device_id: Uuid, identity: &IdentityKeyPair) -> [u8; 32] {
    let (statement, head) = signed_statement(
        primary.account_id,
        primary.chain_version + 1,
        primary.chain_head,
        &[(primary.device_id, &primary.identity), (device_id, identity)],
        (primary.device_id, &primary.identity),
    );
    let (status, body) = submit(app, primary.account_id, &like(primary), &statement).await;
    assert_eq!(status, axum::http::StatusCode::CREATED, "accepting a pending device must succeed: {body}");
    head
}

pub async fn cleanup_account(pool: &sqlx::PgPool, account_id: Uuid) {
    sqlx::query!("DELETE FROM accounts WHERE id = $1", account_id).execute(pool).await.unwrap();
}
