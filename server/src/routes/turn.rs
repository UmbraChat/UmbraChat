use axum::Json;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::auth::AuthenticatedDevice;
use crate::error::{ApiError, not_found, server_error};

const TTL_SECS: u64 = 600;

#[derive(Serialize)]
pub struct TurnCredentials {
    urls: Vec<String>,
    username: String,
    credential: String,
}

/// coturn `use-auth-secret` scheme: username is "<expiry>:<nonce>", credential is
/// base64(HMAC-SHA1(secret, username)). The nonce is random, not the device id, so
/// the relay's own logs can't correlate a call with an account.
fn mint(secret: &str, expiry: u64, nonce: Uuid) -> (String, String) {
    let username = format!("{expiry}:{nonce}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    (username, credential)
}

/// Compose passes unset variables as empty strings; treat those as unconfigured.
fn env_set(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub async fn turn_credentials(AuthenticatedDevice(_caller): AuthenticatedDevice) -> Result<Json<TurnCredentials>, ApiError> {
    let (Some(urls), Some(secret)) = (env_set("TURN_URLS"), env_set("TURN_SECRET")) else {
        return Err(not_found("TURN relay not configured"));
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| server_error())?.as_secs();
    let (username, credential) = mint(&secret, now + TTL_SECS, Uuid::new_v4());
    let urls = urls.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect();
    Ok(Json(TurnCredentials { urls, username, credential }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_matches_an_independent_hmac_sha1() {
        let nonce = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        let (username, credential) = mint("s3cret", 1_700_000_600, nonce);
        assert_eq!(username, "1700000600:00000000-0000-0000-0000-000000000001");
        assert_eq!(credential, "Z3BkWvLp+CqtKf6GslFl/TTw4KA=");
    }
}
