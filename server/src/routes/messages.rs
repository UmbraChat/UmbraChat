use axum::{extract::State, http::StatusCode, Extension, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::{Authenticated, AuthenticatedDevice};
use crate::error::{bad_request, server_error, ApiError};
use crate::routes::push::notify_device;

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub recipient_device_id: Uuid,
    pub ciphertext: String, // base64
}

#[derive(Serialize)]
pub struct SendMessageResponse {
    pub id: Uuid,
}

pub async fn send_message(
    State(pool): State<PgPool>,
    Extension(vapid_private_key): Extension<Arc<String>>,
    Authenticated { device_id: sender_device_id, body }: Authenticated<SendMessageRequest>,
) -> Result<(StatusCode, Json<SendMessageResponse>), ApiError> {
    let ciphertext = STANDARD.decode(&body.ciphertext).map_err(|_| bad_request("ciphertext is not valid base64"))?;

    let sender_account_id = sqlx::query_scalar!("SELECT account_id FROM devices WHERE id = $1", sender_device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?
        .ok_or_else(|| bad_request("unknown sender device"))?;

    let recipient_active = sqlx::query_scalar!("SELECT active FROM devices WHERE id = $1", body.recipient_device_id)
        .fetch_optional(&pool)
        .await
        .map_err(|_| server_error())?;
    if recipient_active != Some(true) {
        return Err(bad_request("unknown recipient device"));
    }

    let id = sqlx::query_scalar!(
        "INSERT INTO messages (sender_device_id, sender_account_id, recipient_device_id, ciphertext) VALUES ($1, $2, $3, $4) RETURNING id",
        sender_device_id,
        sender_account_id,
        body.recipient_device_id,
        ciphertext,
    )
    .fetch_one(&pool)
    .await
    .map_err(|_| server_error())?;

    // Best-effort, never blocks or fails the send itself - see notify_device's
    // own doc comment for why.
    notify_device(&pool, &vapid_private_key, body.recipient_device_id).await;

    Ok((StatusCode::CREATED, Json(SendMessageResponse { id })))
}

#[derive(Serialize)]
pub struct ReceivedMessage {
    pub sender_account_id: Uuid,
    pub sender_device_id: Uuid,
    pub ciphertext: String, // base64
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn fetch_messages(
    State(pool): State<PgPool>,
    AuthenticatedDevice(device_id): AuthenticatedDevice,
) -> Result<Json<Vec<ReceivedMessage>>, ApiError> {
    let mut rows = sqlx::query!(
        "DELETE FROM messages WHERE recipient_device_id = $1 RETURNING sender_account_id, sender_device_id, ciphertext, created_at",
        device_id
    )
    .fetch_all(&pool)
    .await
    .map_err(|_| server_error())?;

    // Postgres's DELETE has no ORDER BY (confirmed against a real instance: it's a
    // syntax error), and RETURNING's row order is otherwise unspecified - sort here
    // by send time instead. This is server receipt time, not the client's original
    // send time; fine at this scale, revisit if clock skew or out-of-order network
    // delivery ever becomes a real problem.
    rows.sort_by_key(|r| r.created_at);

    Ok(Json(
        rows.into_iter()
            .map(|r| ReceivedMessage {
                sender_account_id: r.sender_account_id,
                sender_device_id: r.sender_device_id,
                ciphertext: STANDARD.encode(r.ciphertext),
                created_at: r.created_at,
            })
            .collect(),
    ))
}
