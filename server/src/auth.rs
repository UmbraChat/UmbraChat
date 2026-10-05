use axum::extract::{FromRef, FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use base64::{engine::general_purpose::STANDARD, Engine};
use libsignal_protocol::IdentityKey;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::error::{server_error, unauthorized, ApiError};

const MAX_CLOCK_SKEW_SECS: i64 = 300;
// 8MB raw file cap (see chat/conversation.ts) plus base64's ~33% overhead plus
// JSON/envelope overhead, with headroom.
const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;

/// Verifies a request signed by the caller's identity private key: the signed
/// message is `METHOD\nPATH\nTIMESTAMP\nSHA256_HEX(BODY)`, checked against the
/// device's stored identity public key. No sessions, no tokens.
async fn verify(
    pool: &PgPool,
    device_id: Uuid,
    timestamp_header: &str,
    signature_header: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<(), ApiError> {
    let timestamp: i64 = timestamp_header.parse().map_err(|_| unauthorized("invalid X-Timestamp"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    if (now - timestamp).abs() > MAX_CLOCK_SKEW_SECS {
        return Err(unauthorized("stale or invalid timestamp"));
    }

    let signature_bytes = STANDARD.decode(signature_header).map_err(|_| unauthorized("invalid X-Signature"))?;

    let public_key_bytes = sqlx::query_scalar!("SELECT ik.public_key FROM identity_keys ik JOIN devices d ON d.id = ik.device_id WHERE ik.device_id = $1 AND d.active", device_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| unauthorized("unknown device"))?;
    let identity_key = IdentityKey::decode(&public_key_bytes).map_err(|_| unauthorized("unknown device"))?;

    let body_hash = hex::encode(Sha256::digest(body));
    let message = format!("{method}\n{path}\n{timestamp}\n{body_hash}");

    if !identity_key.public_key().verify_signature(message.as_bytes(), &signature_bytes) {
        return Err(unauthorized("signature does not verify"));
    }

    Ok(())
}

fn device_id_header(parts: &Parts) -> Result<Uuid, ApiError> {
    parts
        .headers
        .get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| unauthorized("missing or invalid X-Device-Id"))
}

fn header_str<'a>(parts: &'a Parts, name: &str) -> Result<&'a str, ApiError> {
    parts
        .headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| unauthorized("missing X-Timestamp or X-Signature"))
}

/// For authenticated requests with no body (GET). Signs over an empty body hash.
pub struct AuthenticatedDevice(pub Uuid);

impl<S> FromRequestParts<S> for AuthenticatedDevice
where
    S: Send + Sync,
    PgPool: FromRef<S>,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let pool = PgPool::from_ref(state);
        let device_id = device_id_header(parts)?;
        let timestamp = header_str(parts, "x-timestamp")?.to_string();
        let signature = header_str(parts, "x-signature")?.to_string();
        verify(&pool, device_id, &timestamp, &signature, parts.method.as_str(), parts.uri.path(), b"").await?;
        Ok(AuthenticatedDevice(device_id))
    }
}

/// For authenticated requests with a JSON body (POST). Signs over the body's hash.
pub struct Authenticated<T> {
    pub device_id: Uuid,
    pub body: T,
}

impl<S, T> FromRequest<S> for Authenticated<T>
where
    S: Send + Sync,
    PgPool: FromRef<S>,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let pool = PgPool::from_ref(state);
        let (parts, body) = req.into_parts();
        let device_id = device_id_header(&parts)?;
        let timestamp = header_str(&parts, "x-timestamp")?.to_string();
        let signature = header_str(&parts, "x-signature")?.to_string();

        let body_bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
            .await
            .map_err(|_| unauthorized("failed to read request body"))?;

        verify(&pool, device_id, &timestamp, &signature, parts.method.as_str(), parts.uri.path(), &body_bytes).await?;

        let body: T = serde_json::from_slice(&body_bytes).map_err(|_| unauthorized("invalid request body"))?;
        Ok(Authenticated { device_id, body })
    }
}
