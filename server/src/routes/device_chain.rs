use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::register::SignedStatementDto;
use crate::auth::{Authenticated, AuthenticatedDevice};
use crate::device_list::{self, Chain, Entry};
use crate::error::{bad_request, forbidden, server_error, ApiError};

pub async fn insert_statement(tx: &mut Transaction<'_, Postgres>, account_id: Uuid, version: u32, bytes: &[u8], signature: &[u8]) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO device_list_statements (account_id, version, bytes, signature) VALUES ($1, $2, $3, $4)",
        account_id,
        version as i32,
        bytes,
        signature,
    )
    .execute(&mut **tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => bad_request("version already taken"),
        _ => server_error(),
    })?;
    Ok(())
}

/// The latest statement of an account, read as a chain state. Locks the account row so two
/// concurrent submissions cannot both extend the same head.
async fn lock_chain(tx: &mut Transaction<'_, Postgres>, account_id: Uuid) -> Result<Option<Chain>, ApiError> {
    sqlx::query!("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", account_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| bad_request("unknown account"))?;
    let latest = sqlx::query!("SELECT bytes, signature FROM device_list_statements WHERE account_id = $1 ORDER BY version DESC LIMIT 1", account_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| server_error())?;
    let Some(row) = latest else { return Ok(None) };
    let s = device_list::decode(&row.bytes).map_err(|_| server_error())?;
    Ok(Some(Chain { account_id, version: s.version, head: device_list::head_of(&row.bytes, &row.signature), devices: s.devices }))
}

#[derive(Serialize)]
pub struct StatementOut {
    pub version: i32,
    pub statement: String, // base64
    pub signature: String, // base64
}

#[derive(Deserialize)]
pub struct SinceParams {
    pub since: Option<i32>,
}

/// Statements newer than `since` (all of them without it), oldest first. Open to any registered
/// device, like the device list it replaces: a sender needs a contact's chain to fan out.
pub async fn get_chain(
    State(pool): State<PgPool>,
    AuthenticatedDevice(_caller): AuthenticatedDevice,
    Path(account_id): Path<Uuid>,
    Query(params): Query<SinceParams>,
) -> Result<Json<Vec<StatementOut>>, ApiError> {
    let rows = sqlx::query!(
        "SELECT version, bytes, signature FROM device_list_statements WHERE account_id = $1 AND version > $2 ORDER BY version",
        account_id,
        params.since.unwrap_or(0),
    )
    .fetch_all(&pool)
    .await
    .map_err(|_| server_error())?;
    Ok(Json(rows.into_iter().map(|r| StatementOut { version: r.version, statement: STANDARD.encode(r.bytes), signature: STANDARD.encode(r.signature) }).collect()))
}

#[derive(Serialize)]
pub struct SubmitResponse {
    pub version: i32,
}

/// Extends the chain with a statement signed by the calling device. Devices the statement adds
/// must be pending ones of this account with exactly the key it lists (that is what activates
/// them); devices it drops are deleted. Anything else is refused.
pub async fn submit_statement(
    State(pool): State<PgPool>,
    Path(account_id): Path<Uuid>,
    Authenticated { device_id: caller, body }: Authenticated<SignedStatementDto>,
) -> Result<(StatusCode, Json<SubmitResponse>), ApiError> {
    let (bytes, signature) = body.decode()?;
    let mut tx = pool.begin().await.map_err(|_| server_error())?;

    let prev = lock_chain(&mut tx, account_id).await?.ok_or_else(|| bad_request("this account has no device list"))?;
    if !prev.devices.iter().any(|d| d.device_id == caller) {
        return Err(forbidden("the calling device is not in this account's device list"));
    }
    let next = device_list::verify_next(Some(&prev), &bytes, &signature).map_err(bad_request)?;
    if device_list::decode(&bytes).map_err(bad_request)?.signer != caller {
        return Err(bad_request("the statement must be signed by the calling device"));
    }

    let added: Vec<&Entry> = next.devices.iter().filter(|d| !prev.devices.iter().any(|p| p.device_id == d.device_id)).collect();
    for entry in added {
        let pending = sqlx::query_scalar!(
            "SELECT ik.public_key FROM devices d JOIN identity_keys ik ON ik.device_id = d.id WHERE d.id = $1 AND d.account_id = $2 AND NOT d.active",
            entry.device_id,
            account_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| bad_request("an added device is not a pending device of this account"))?;
        if pending != entry.identity_key {
            return Err(bad_request("an added device's key differs from the one it registered"));
        }
        sqlx::query!("UPDATE devices SET active = true WHERE id = $1", entry.device_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| server_error())?;
    }
    for gone in prev.devices.iter().filter(|p| !next.devices.iter().any(|d| d.device_id == p.device_id)) {
        sqlx::query!("DELETE FROM devices WHERE id = $1", gone.device_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| server_error())?;
    }

    insert_statement(&mut tx, account_id, next.version, &bytes, &signature).await?;
    tx.commit().await.map_err(|_| server_error())?;
    Ok((StatusCode::CREATED, Json(SubmitResponse { version: next.version as i32 })))
}
