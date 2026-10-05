mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::app;
use tower::ServiceExt;
use umbrachat_server::protocol::{PROTOCOL_HEADER, PROTOCOL_VERSION};

async fn send(version: Option<&str>, method: &str) -> axum::response::Response {
    let mut builder = Request::builder().method(method).uri("/v1/push-key").header("origin", "https://client.example");
    if let Some(v) = version {
        builder = builder.header(PROTOCOL_HEADER, v);
    }
    app().await.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap()
}

#[tokio::test]
async fn a_matching_version_is_served_and_stamped() {
    let response = send(Some(&PROTOCOL_VERSION.to_string()), "GET").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers().get(PROTOCOL_HEADER).unwrap(), PROTOCOL_VERSION.to_string().as_str());
}

#[tokio::test]
async fn a_different_or_missing_version_is_refused_but_the_server_still_says_its_own() {
    for version in [Some((PROTOCOL_VERSION + 1).to_string()), Some("0".to_string()), Some("garbage".to_string()), None] {
        let response = send(version.as_deref(), "GET").await;
        assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED, "{version:?}");
        assert_eq!(response.headers().get(PROTOCOL_HEADER).unwrap(), PROTOCOL_VERSION.to_string().as_str(), "{version:?}");
        // Readable by a client served from another origin, or it could never show the reason.
        assert_eq!(response.headers().get("access-control-allow-origin").unwrap(), "*", "{version:?}");
        assert!(response.headers().get("access-control-expose-headers").unwrap().to_str().unwrap().contains(PROTOCOL_HEADER));
    }
}

#[tokio::test]
async fn the_web_app_declares_the_same_version() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/src/api/protocol.ts"));
    // The Docker image of the server builds without the web sources.
    let Ok(source) = source else { return };
    let line = source.lines().find(|l| l.contains("export const PROTOCOL_VERSION")).expect("web/src/api/protocol.ts declares PROTOCOL_VERSION");
    let declared: u32 = line.split('=').nth(1).unwrap().trim().trim_end_matches(';').trim().parse().unwrap();
    assert_eq!(declared, PROTOCOL_VERSION, "bump web/src/api/protocol.ts and server/src/protocol.rs together");
}
