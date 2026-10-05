use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

use crate::error::ErrorResponse;

/// Version of everything an app and a server must agree on to talk at all: the HTTP API and
/// the format of the envelopes it carries. It is compared for strict equality, in both
/// directions, before anything else happens: any difference means "update", with no
/// negotiation to get wrong. Bump it with every change an older or newer app could
/// misread, and in `web/src/api/protocol.ts` too (`tests/protocol.rs` checks they match).
pub const PROTOCOL_VERSION: u32 = 2;
pub const PROTOCOL_HEADER: &str = "x-umbra-protocol";

/// Rejects a request whose app does not speak exactly this version, and stamps this server's
/// version on every response so the app can refuse a server that does not match either.
pub async fn enforce(request: Request, next: Next) -> Response {
    let sent = request
        .headers()
        .get(PROTOCOL_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok());
    let mut response = if sent == Some(PROTOCOL_VERSION) { next.run(request).await } else { rejection(sent).into_response() };
    response
        .headers_mut()
        .insert(HeaderName::from_static(PROTOCOL_HEADER), HeaderValue::from(PROTOCOL_VERSION));
    response
}

fn rejection(sent: Option<u32>) -> (StatusCode, Json<ErrorResponse>) {
    let error = match sent {
        Some(v) => format!("version mismatch: this app speaks UmbraChat protocol {v}, this server speaks {PROTOCOL_VERSION}. Both sides must run the same build"),
        None => format!("this server speaks UmbraChat protocol {PROTOCOL_VERSION} and the app sent no version: probably an older build. Both sides must run the same build"),
    };
    (StatusCode::UPGRADE_REQUIRED, Json(ErrorResponse { error }))
}
