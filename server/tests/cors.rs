mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{app, request};
use serde_json::json;
use tower::ServiceExt;

// A client served from somewhere else than the API (the user picks the server at runtime)
// only works if the browser's preflight is answered for the signed-request headers.
#[tokio::test]
async fn preflight_from_another_origin_is_allowed() {
    let app = app().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/messages")
                .header("origin", "https://client.example")
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "x-device-id,x-timestamp,x-signature,content-type")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success(), "preflight status {}", response.status());
    assert_eq!(response.headers().get("access-control-allow-origin").unwrap(), "*");
}

#[tokio::test]
async fn push_key_is_public_and_a_valid_uncompressed_p256_point() {
    let app = app().await;
    let (status, body) = request(&app, "GET", "/v1/push-key", &[], json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    let key = body["public_key"].as_str().unwrap();
    // 65 bytes (0x04 + X + Y), base64url without padding.
    assert_eq!(key.len(), 87, "{key}");
    assert!(key.starts_with('B'), "{key}");
}
