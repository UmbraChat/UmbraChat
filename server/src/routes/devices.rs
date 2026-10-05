use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use super::register::{insert_device_bundle, validate_bundle, RegisterRequest};
use crate::auth::AuthenticatedDevice;
use crate::error::{bad_request, forbidden, not_found, server_error, ApiError};
use base64::{engine::general_purpose::STANDARD, Engine};

const LINK_CODE_TTL: Duration = Duration::minutes(5);
const MAX_PENDING_DEVICES: i64 = 5;

async fn require_same_account(pool: &PgPool, caller_device_id: Uuid, account_id: Uuid) -> Result<(), ApiError> {
    let caller_account_id = sqlx::query_scalar!("SELECT account_id FROM devices WHERE id = $1", caller_device_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| server_error())?;
    if caller_account_id != account_id {
        return Err(forbidden("device does not belong to this account"));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct LinkInitResponse {
    pub code: String,
}

/// Only an already-authenticated device of `account_id` can start a link -
/// otherwise anyone could mint a pairing code for someone else's account.
pub async fn link_init(
    State(pool): State<PgPool>,
    AuthenticatedDevice(caller_device_id): AuthenticatedDevice,
    Path(account_id): Path<Uuid>,
) -> Result<Json<LinkInitResponse>, ApiError> {
    require_same_account(&pool, caller_device_id, account_id).await?;

    // 8 random bytes, hex-encoded: short enough to type, long enough that
    // guessing it inside a 5-minute window isn't practical.
    let mut raw = [0u8; 8];
    rand::rng().fill_bytes(&mut raw);
    let code = hex::encode(raw);

    let expires_at = Utc::now() + LINK_CODE_TTL;
    sqlx::query!(
        "INSERT INTO pending_device_links (code, account_id, expires_at) VALUES ($1, $2, $3)",
        code,
        account_id,
        expires_at,
    )
    .execute(&pool)
    .await
    .map_err(|_| server_error())?;

    Ok(Json(LinkInitResponse { code }))
}

#[derive(Deserialize)]
pub struct CompleteLinkRequest {
    pub code: String,
    pub label: String,
    #[serde(flatten)]
    pub bundle: RegisterRequest,
}

#[derive(Serialize)]
pub struct CompleteLinkResponse {
    pub device_id: Uuid,
}

/// Unauthenticated: the new device has no credentials yet. Authorization
/// comes entirely from possessing a valid, unexpired code for this account.
pub async fn complete_link(
    State(pool): State<PgPool>,
    Path(account_id): Path<Uuid>,
    Json(req): Json<CompleteLinkRequest>,
) -> Result<(StatusCode, Json<CompleteLinkResponse>), ApiError> {
    let bundle = validate_bundle(&req.bundle)?;

    let mut tx = pool.begin().await.map_err(|_| server_error())?;

    let consumed = sqlx::query!(
        "DELETE FROM pending_device_links WHERE code = $1 AND account_id = $2 AND expires_at > now() RETURNING code",
        req.code,
        account_id,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| server_error())?;
    if consumed.is_none() {
        return Err(bad_request("link code is invalid, expired, or already used"));
    }

    let pending: i64 = sqlx::query_scalar!("SELECT count(*) FROM devices WHERE account_id = $1 AND NOT active", account_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?
        .unwrap_or(0);
    if pending >= MAX_PENDING_DEVICES {
        return Err(bad_request("too many devices are waiting to be accepted"));
    }

    // Pending until a statement signed by an existing device includes it (routes/device_chain.rs).
    let device_id = sqlx::query_scalar!("INSERT INTO devices (account_id, label, active) VALUES ($1, $2, false) RETURNING id", account_id, req.label)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;

    insert_device_bundle(&mut tx, device_id, &bundle).await?;

    tx.commit().await.map_err(|_| server_error())?;

    Ok((StatusCode::CREATED, Json(CompleteLinkResponse { device_id })))
}

#[derive(Serialize)]
pub struct DeviceOut {
    pub id: Uuid,
    pub label: String,
    pub created_at: DateTime<Utc>,
}

/// No ownership check: a sender needs to discover a *contact's* device list
/// to fan out to it, the same visibility the prekey-bundle endpoint already
/// has. See plan.md for the accepted metadata trade-off.
pub async fn list_devices(State(pool): State<PgPool>, AuthenticatedDevice(_caller): AuthenticatedDevice, Path(account_id): Path<Uuid>) -> Result<Json<Vec<DeviceOut>>, ApiError> {
    let rows = sqlx::query!("SELECT id, label, created_at FROM devices WHERE account_id = $1 AND active ORDER BY created_at", account_id)
        .fetch_all(&pool)
        .await
        .map_err(|_| server_error())?;

    Ok(Json(
        rows.into_iter().map(|r| DeviceOut { id: r.id, label: r.label, created_at: r.created_at }).collect(),
    ))
}

#[derive(Serialize)]
pub struct PendingDeviceOut {
    pub id: Uuid,
    pub label: String,
    pub identity_public_key: String, // base64
    pub created_at: DateTime<Utc>,
}

/// Devices that registered with a link code and wait for a signed statement that includes them.
/// Same-account only: the signing device shows each one's key so the user can compare it with
/// the new device's own screen before signing.
pub async fn list_pending_devices(
    State(pool): State<PgPool>,
    AuthenticatedDevice(caller_device_id): AuthenticatedDevice,
    Path(account_id): Path<Uuid>,
) -> Result<Json<Vec<PendingDeviceOut>>, ApiError> {
    require_same_account(&pool, caller_device_id, account_id).await?;
    let rows = sqlx::query!(
        "SELECT d.id, d.label, d.created_at, ik.public_key FROM devices d JOIN identity_keys ik ON ik.device_id = d.id WHERE d.account_id = $1 AND NOT d.active ORDER BY d.created_at",
        account_id
    )
    .fetch_all(&pool)
    .await
    .map_err(|_| server_error())?;
    Ok(Json(
        rows.into_iter()
            .map(|r| PendingDeviceOut { id: r.id, label: r.label, identity_public_key: STANDARD.encode(r.public_key), created_at: r.created_at })
            .collect(),
    ))
}

#[derive(Serialize)]
pub struct DeviceStatus {
    pub active: bool,
}

/// Unauthenticated: a pending device cannot sign requests yet and has to learn when it was
/// accepted. The id is an unguessable UUID and the answer is one bit.
pub async fn device_status(State(pool): State<PgPool>, Path(device_id): Path<Uuid>) -> Result<Json<DeviceStatus>, ApiError> {
    let active = sqlx::query_scalar!("SELECT active FROM devices WHERE id = $1", device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| not_found("device not found"))?;
    Ok(Json(DeviceStatus { active }))
}
