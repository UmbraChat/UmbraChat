use base64::{engine::general_purpose::STANDARD, Engine};
mod common;

use http_body_util::BodyExt;
use libsignal_protocol::{IdentityKeyPair, KeyPair};
use serde_json::{json, Value};
use tower::ServiceExt;
use umbrachat_server::{db, routes};

async fn app() -> axum::Router {
    let pool = db::connect().await;
    routes::router(pool, "4rISdCDvPIdiTUpJbPqHt2gi3TCVqEq0sCnqi9iykXQ".to_string())
}

fn valid_register_body() -> Value {
    let identity = IdentityKeyPair::generate(&mut rand::rng());
    common::register_body(&identity, uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).0
}

#[tokio::test]
async fn register_with_valid_bundle_returns_201() {
    let app = app().await;
    let body = valid_register_body();

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/v1/register")
                .header("content-type", "application/json")
                .header(umbrachat_server::protocol::PROTOCOL_HEADER, umbrachat_server::protocol::PROTOCOL_VERSION.to_string())
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::CREATED);

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    let account_id: uuid::Uuid = json["account_id"].as_str().expect("account_id must be a string").parse().unwrap();
    let device_id: uuid::Uuid = json["device_id"].as_str().expect("device_id must be a string").parse().unwrap();
    assert_ne!(account_id, device_id, "the first device must not reuse the account's own id");

    // Clean up so repeated test runs don't accumulate rows in the dev database.
    let pool = db::connect().await;
    sqlx::query!("DELETE FROM accounts WHERE id = $1", account_id)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn register_with_invalid_signature_returns_4xx_and_persists_nothing() {
    let app = app().await;
    let mut body = valid_register_body();
    // Corrupt the signature so it no longer verifies against the identity key.
    body["signed_prekey"]["signature"] = json!(STANDARD.encode([0u8; 64]));

    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/v1/register")
                .header("content-type", "application/json")
                .header(umbrachat_server::protocol::PROTOCOL_HEADER, umbrachat_server::protocol::PROTOCOL_VERSION.to_string())
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.status().is_client_error());

    // Nothing should have been persisted for this identity key.
    let identity_public_key = body["identity_public_key"].as_str().unwrap();
    let identity_key_bytes = STANDARD.decode(identity_public_key).unwrap();
    let pool = db::connect().await;
    let count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM identity_keys WHERE public_key = $1",
        identity_key_bytes
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(count, 0);
}

#[tokio::test]
async fn register_with_invalid_kyber_signature_returns_4xx_and_persists_nothing() {
    let app = app().await;
    let mut body = valid_register_body();
    body["kyber_signed_prekey"]["signature"] = json!(STANDARD.encode([0u8; 64]));

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/v1/register")
                .header("content-type", "application/json")
                .header(umbrachat_server::protocol::PROTOCOL_HEADER, umbrachat_server::protocol::PROTOCOL_VERSION.to_string())
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.status().is_client_error());

    let identity_public_key = body["identity_public_key"].as_str().unwrap();
    let identity_key_bytes = STANDARD.decode(identity_public_key).unwrap();
    let pool = db::connect().await;
    let count: i64 = sqlx::query_scalar!(
        "SELECT count(*) FROM identity_keys WHERE public_key = $1",
        identity_key_bytes
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap_or(0);
    assert_eq!(count, 0);
}

#[tokio::test]
async fn register_with_too_many_one_time_prekeys_returns_4xx() {
    let app = app().await;
    let mut body = valid_register_body();
    let mut rng = rand::rng();
    let extra_prekeys: Vec<Value> = (0..101)
        .map(|i| {
            let pair = KeyPair::generate(&mut rng);
            json!({ "key_id": i, "public_key": STANDARD.encode(pair.public_key.serialize()) })
        })
        .collect();
    body["one_time_prekeys"] = json!(extra_prekeys);

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/v1/register")
                .header("content-type", "application/json")
                .header(umbrachat_server::protocol::PROTOCOL_HEADER, umbrachat_server::protocol::PROTOCOL_VERSION.to_string())
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.status().is_client_error());
}
