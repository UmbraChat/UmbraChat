use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use libsignal_protocol::IdentityKey;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use super::register::{decode_signed_prekey, SignedPrekeyDto};
use crate::auth::{Authenticated, AuthenticatedDevice};
use crate::error::{bad_request, forbidden, not_found, server_error, ApiError};

#[derive(Serialize)]
pub struct SignedPrekeyOut {
    pub key_id: i32,
    pub public_key: String, // base64
    pub signature: String,  // base64
}

#[derive(Serialize)]
pub struct OneTimePrekeyOut {
    pub key_id: i32,
    pub public_key: String, // base64
}

#[derive(Serialize)]
pub struct PrekeyBundleResponse {
    pub identity_public_key: String, // base64
    pub registration_id: i32,
    pub signed_prekey: SignedPrekeyOut,
    // Post-quantum prekey, mandatory: libsignal-protocol's session establishment
    // uses PQXDH, not classic X3DH.
    pub kyber_signed_prekey: SignedPrekeyOut,
    pub one_time_prekey: Option<OneTimePrekeyOut>,
}

pub async fn get_prekey_bundle(
    State(pool): State<PgPool>,
    AuthenticatedDevice(_caller): AuthenticatedDevice,
    Path(device_id): Path<Uuid>,
) -> Result<Json<PrekeyBundleResponse>, ApiError> {
    let identity = sqlx::query!("SELECT ik.public_key, ik.registration_id FROM identity_keys ik JOIN devices d ON d.id = ik.device_id WHERE ik.device_id = $1 AND d.active", device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| not_found("device not found"))?;

    let signed_prekey = sqlx::query!("SELECT key_id, public_key, signature FROM signed_prekeys WHERE device_id = $1", device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| not_found("device has no signed prekey"))?;

    let kyber_signed_prekey = sqlx::query!("SELECT key_id, public_key, signature FROM kyber_signed_prekeys WHERE device_id = $1", device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| not_found("device has no kyber signed prekey"))?;

    let one_time_prekey = sqlx::query!(
        r#"
        UPDATE prekeys
        SET used = true
        WHERE device_id = $1 AND key_id = (
            SELECT key_id FROM prekeys WHERE device_id = $1 AND used = false ORDER BY key_id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING key_id, public_key
        "#,
        device_id
    )
    .fetch_optional(&pool)
    .await
    .map_err(|_| server_error())?;

    Ok(Json(PrekeyBundleResponse {
        identity_public_key: STANDARD.encode(identity.public_key),
        registration_id: identity.registration_id,
        signed_prekey: SignedPrekeyOut {
            key_id: signed_prekey.key_id,
            public_key: STANDARD.encode(signed_prekey.public_key),
            signature: STANDARD.encode(signed_prekey.signature),
        },
        kyber_signed_prekey: SignedPrekeyOut {
            key_id: kyber_signed_prekey.key_id,
            public_key: STANDARD.encode(kyber_signed_prekey.public_key),
            signature: STANDARD.encode(kyber_signed_prekey.signature),
        },
        one_time_prekey: one_time_prekey.map(|k| OneTimePrekeyOut {
            key_id: k.key_id,
            public_key: STANDARD.encode(k.public_key),
        }),
    }))
}

#[derive(Deserialize)]
pub struct SignedPrekeysRequest {
    pub signed_prekey: SignedPrekeyDto,
    pub kyber_signed_prekey: SignedPrekeyDto,
}

/// A device replaces the signed prekeys its bundle serves (rotation). The old public keys are
/// dropped at once: only the device needs the old private keys, for first messages already built
/// against them, and it keeps those itself. Key ids must increase, so two different keys never
/// share an id; resending the current keys is accepted, so a client whose answer was lost can retry.
pub async fn replace_signed_prekeys(
    State(pool): State<PgPool>,
    Path(device_id): Path<Uuid>,
    Authenticated { device_id: caller, body: req }: Authenticated<SignedPrekeysRequest>,
) -> Result<StatusCode, ApiError> {
    if caller != device_id {
        return Err(forbidden("a device can only rotate its own prekeys"));
    }

    let mut tx = pool.begin().await.map_err(|_| server_error())?;
    let identity = sqlx::query_scalar!("SELECT public_key FROM identity_keys WHERE device_id = $1", device_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
    let identity = IdentityKey::decode(&identity).map_err(|_| server_error())?;
    let (signed_key, signed_signature) = decode_signed_prekey(&identity, &req.signed_prekey, "signed_prekey", false)?;
    let (kyber_key, kyber_signature) = decode_signed_prekey(&identity, &req.kyber_signed_prekey, "kyber_signed_prekey", true)?;

    let current_signed = sqlx::query!("SELECT key_id, public_key FROM signed_prekeys WHERE device_id = $1 FOR UPDATE", device_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
    let current_kyber = sqlx::query!("SELECT key_id, public_key FROM kyber_signed_prekeys WHERE device_id = $1 FOR UPDATE", device_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
    let acceptable = |current_id: i32, current_key: &[u8], new_id: i32, new_key: &[u8]| new_id > current_id || (new_id == current_id && new_key == current_key);
    if !acceptable(current_signed.key_id, &current_signed.public_key, req.signed_prekey.key_id, &signed_key)
        || !acceptable(current_kyber.key_id, &current_kyber.public_key, req.kyber_signed_prekey.key_id, &kyber_key)
    {
        return Err(bad_request("a new signed prekey needs a higher key_id than the current one"));
    }

    sqlx::query!(
        "UPDATE signed_prekeys SET key_id = $2, public_key = $3, signature = $4 WHERE device_id = $1",
        device_id,
        req.signed_prekey.key_id,
        signed_key,
        signed_signature,
    )
    .execute(&mut *tx)
    .await
    .map_err(|_| server_error())?;
    sqlx::query!(
        "UPDATE kyber_signed_prekeys SET key_id = $2, public_key = $3, signature = $4 WHERE device_id = $1",
        device_id,
        req.kyber_signed_prekey.key_id,
        kyber_key,
        kyber_signature,
    )
    .execute(&mut *tx)
    .await
    .map_err(|_| server_error())?;

    tx.commit().await.map_err(|_| server_error())?;
    Ok(StatusCode::NO_CONTENT)
}
