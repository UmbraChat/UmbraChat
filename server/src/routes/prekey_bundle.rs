use axum::{
    extract::{Path, State},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::AuthenticatedDevice;
use crate::error::{not_found, server_error, ApiError};

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
