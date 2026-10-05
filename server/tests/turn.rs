mod common;

use common::{app, cleanup_account, register_account, request, sign};
use serde_json::json;
use umbrachat_server::db;

#[tokio::test]
async fn unconfigured_relay_is_404_and_unauthenticated_is_rejected() {
    let app = app().await;
    let primary = register_account(&app).await;

    let (status, _) = request(&app, "GET", "/v1/turn-credentials", &[], json!(null)).await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);

    let (ts, sig) = sign(&primary.identity, "GET", "/v1/turn-credentials", b"");
    let device_id = primary.device_id.to_string();
    let headers = [("x-device-id", device_id.as_str()), ("x-timestamp", ts.as_str()), ("x-signature", sig.as_str())];
    let (status, _) = request(&app, "GET", "/v1/turn-credentials", &headers, json!(null)).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);

    cleanup_account(&db::connect().await, primary.account_id).await;
}
