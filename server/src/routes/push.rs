use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
use web_push::{ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushClient, WebPushMessageBuilder};

use crate::auth::{Authenticated, AuthenticatedDevice};
use crate::error::{forbidden, server_error, ApiError};

#[derive(Deserialize)]
pub struct SubscriptionKeysIn {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Deserialize)]
pub struct RegisterSubscriptionRequest {
    pub endpoint: String,
    pub keys: SubscriptionKeysIn,
}

#[derive(Serialize)]
pub struct PushKeyResponse {
    pub public_key: String,
}

/// The public half of this server's VAPID key, which a browser needs to subscribe to its
/// push service. Served by the server itself so a client that is not built for one particular
/// server (it asks the user which one to use) can still enable notifications. Public by design.
pub async fn push_public_key(Extension(vapid_private_key): Extension<Arc<String>>) -> Result<Json<PushKeyResponse>, ApiError> {
    let builder = VapidSignatureBuilder::from_base64_no_sub(&vapid_private_key).map_err(|_| server_error())?;
    Ok(Json(PushKeyResponse { public_key: URL_SAFE_NO_PAD.encode(builder.get_public_key()) }))
}

/// A device may only manage its own subscription - there's no "someone else's
/// devices" concept here, unlike list_devices' deliberately open visibility.
fn require_own_device(caller_device_id: Uuid, path_device_id: Uuid) -> Result<(), ApiError> {
    if caller_device_id != path_device_id {
        return Err(forbidden("can only manage this device's own push subscription"));
    }
    Ok(())
}

pub async fn register_subscription(
    State(pool): State<PgPool>,
    Path(device_id): Path<Uuid>,
    Authenticated { device_id: caller_device_id, body: req }: Authenticated<RegisterSubscriptionRequest>,
) -> Result<StatusCode, ApiError> {
    require_own_device(caller_device_id, device_id)?;

    sqlx::query!(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (device_id) DO UPDATE SET endpoint = $2, p256dh = $3, auth = $4",
        device_id,
        req.endpoint,
        req.keys.p256dh,
        req.keys.auth,
    )
    .execute(&pool)
    .await
    .map_err(|_| server_error())?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unregister_subscription(
    State(pool): State<PgPool>,
    AuthenticatedDevice(caller_device_id): AuthenticatedDevice,
    Path(device_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    require_own_device(caller_device_id, device_id)?;

    sqlx::query!("DELETE FROM push_subscriptions WHERE device_id = $1", device_id)
        .execute(&pool)
        .await
        .map_err(|_| server_error())?;

    Ok(StatusCode::NO_CONTENT)
}

/// Best-effort: a message send must never fail because a push notification
/// couldn't be delivered. Content-free by design - the payload never carries
/// a sender, message id, or any hint of content, so the server stays exactly
/// as "dumb" here as everywhere else (see plan Decisions). An expired/gone
/// subscription (410/404 from the push service) is deleted so it isn't
/// retried forever.
pub async fn notify_device(pool: &PgPool, vapid_private_key: &Arc<String>, device_id: Uuid) {
    let Ok(Some(row)) = sqlx::query!(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE device_id = $1",
        device_id
    )
    .fetch_optional(pool)
    .await
    else {
        return;
    };

    let subscription_info = SubscriptionInfo::new(row.endpoint, row.p256dh, row.auth);

    let Ok(sig_builder) = VapidSignatureBuilder::from_base64(vapid_private_key, &subscription_info) else {
        return;
    };
    let Ok(signature) = sig_builder.build() else { return };

    let mut builder = WebPushMessageBuilder::new(&subscription_info);
    // No payload content at all - the Service Worker's push handler decides what
    // to show from the recipient's own locally-stored display preference.
    builder.set_payload(ContentEncoding::Aes128Gcm, b"");
    builder.set_vapid_signature(signature);

    let Ok(message) = builder.build() else { return };

    let client = web_push::HyperWebPushClient::new();
    if let Err(err) = client.send(message).await {
        eprintln!("push notification failed for device {device_id}: {err}");
        if matches!(err, web_push::WebPushError::EndpointNotValid(_) | web_push::WebPushError::EndpointNotFound(_)) {
            let _ = sqlx::query!("DELETE FROM push_subscriptions WHERE device_id = $1", device_id)
                .execute(pool)
                .await;
        }
    }
}

/// Exposed only so `messages.rs` can call `notify_device` with the shared
/// VAPID key without every route handler needing its own extractor for it.
pub type VapidKeyExtension = Extension<Arc<String>>;
