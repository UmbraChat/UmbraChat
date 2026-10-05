mod device_chain;
mod devices;
mod messages;
mod prekey_bundle;
pub mod push;
mod register;
mod turn;

use axum::{
    http::{HeaderName, Method},
    routing::{get, post},
    Extension, Router,
};
use sqlx::PgPool;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::protocol;

pub fn router(pool: PgPool, vapid_private_key: String) -> Router {
    // Registration and device-linking are public, unauthenticated endpoints with
    // no cookies/credentials involved, so a permissive CORS policy is fine.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers(Any)
        .expose_headers([HeaderName::from_static(protocol::PROTOCOL_HEADER)]);

    Router::new()
        .route("/v1/register", post(register::register))
        .route("/v1/devices/{id}/prekey-bundle", get(prekey_bundle::get_prekey_bundle))
        .route("/v1/devices/{id}/signed-prekeys", post(prekey_bundle::replace_signed_prekeys))
        .route("/v1/devices/{id}/status", get(devices::device_status))
        .route(
            "/v1/devices/{id}/push-subscription",
            post(push::register_subscription).delete(push::unregister_subscription),
        )
        .route("/v1/accounts/{id}/devices", get(devices::list_devices).post(devices::complete_link))
        .route("/v1/accounts/{id}/devices/link-init", post(devices::link_init))
        .route("/v1/accounts/{id}/pending-devices", get(devices::list_pending_devices))
        .route("/v1/accounts/{id}/device-list", get(device_chain::get_chain).post(device_chain::submit_statement))
        .route("/v1/turn-credentials", get(turn::turn_credentials))
        .route("/v1/push-key", get(push::push_public_key))
        .route("/v1/messages", post(messages::send_message).get(messages::fetch_messages))
        .layer(axum::middleware::from_fn(protocol::enforce))
        .layer(cors)
        .layer(Extension(Arc::new(vapid_private_key)))
        .with_state(pool)
}
