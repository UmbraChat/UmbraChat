mod common;

use base64::{engine::general_purpose::STANDARD, Engine};
use common::{accept, app, auth_headers, as_refs, cleanup_account, get_json, like, link_init, link_pending, new_device_bundle, register_account, request, sign, signed_statement, submit, TestAccountLike};
use libsignal_protocol::IdentityKeyPair;
use serde_json::json;
use umbrachat_server::db;

#[tokio::test]
async fn a_pending_device_is_inert_until_a_statement_includes_it() {
    let app = app().await;
    let primary = register_account(&app).await;
    let stranger = register_account(&app).await;
    let (device_id, identity) = link_pending(&app, &primary, "Laptop").await;

    // Not listed, no bundle, cannot authenticate, receives nothing, but reports its status.
    let (_, listed) = get_json(&app, &format!("/v1/accounts/{}/devices", primary.account_id), &like(&stranger)).await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "a pending device must not be listed");
    let (bundle_status, _) = get_json(&app, &format!("/v1/devices/{device_id}/prekey-bundle"), &like(&stranger)).await;
    assert_eq!(bundle_status, axum::http::StatusCode::NOT_FOUND);
    let probe = TestAccountLike { device_id, identity: &identity };
    let (auth_status, _) = get_json(&app, &format!("/v1/devices/{}/prekey-bundle", primary.device_id), &probe).await;
    assert_eq!(auth_status, axum::http::StatusCode::UNAUTHORIZED, "a pending device must not authenticate");
    let send = json!({ "recipient_device_id": device_id.to_string(), "ciphertext": STANDARD.encode(b"x") });
    let body = send.to_string();
    let (ts, sig) = sign(&primary.identity, "POST", "/v1/messages", body.as_bytes());
    let headers = auth_headers(primary.device_id, ts, sig);
    let (send_status, _) = request(&app, "POST", "/v1/messages", &as_refs(&headers), send).await;
    assert_eq!(send_status, axum::http::StatusCode::BAD_REQUEST, "nothing may be queued for a pending device");
    let (status, status_body) = request(&app, "GET", &format!("/v1/devices/{device_id}/status"), &[], json!(null)).await;
    assert_eq!((status, status_body["active"].as_bool()), (axum::http::StatusCode::OK, Some(false)));

    // The primary sees it with its key, signs a statement, and the device becomes real.
    let (_, pending) = get_json(&app, &format!("/v1/accounts/{}/pending-devices", primary.account_id), &like(&primary)).await;
    assert_eq!(pending[0]["identity_public_key"].as_str().unwrap(), STANDARD.encode(identity.identity_key().serialize()));
    accept(&app, &primary, device_id, &identity).await;

    let (_, listed) = get_json(&app, &format!("/v1/accounts/{}/devices", primary.account_id), &like(&stranger)).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let (ok_status, _) = get_json(&app, &format!("/v1/devices/{}/prekey-bundle", primary.device_id), &probe).await;
    assert_eq!(ok_status, axum::http::StatusCode::OK, "the accepted device must now authenticate");
    let (_, status_body) = request(&app, "GET", &format!("/v1/devices/{device_id}/status"), &[], json!(null)).await;
    assert_eq!(status_body["active"].as_bool(), Some(true));

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
    cleanup_account(&pool, stranger.account_id).await;
}

#[tokio::test]
async fn a_statement_that_does_not_match_what_registered_is_refused() {
    let app = app().await;
    let primary = register_account(&app).await;
    let (device_id, identity) = link_pending(&app, &primary, "Laptop").await;
    let me = (primary.device_id, &primary.identity);
    let post = |version, prev, devices: Vec<(uuid::Uuid, &IdentityKeyPair)>, signer| {
        let (statement, _) = signed_statement(primary.account_id, version, prev, &devices, signer);
        statement
    };
    let caller = like(&primary);

    // A ghost: a device id that never registered.
    let ghost = IdentityKeyPair::generate(&mut rand::rng());
    let s = post(2, primary.chain_head, vec![me, (uuid::Uuid::new_v4(), &ghost)], me);
    assert_eq!(submit(&app, primary.account_id, &caller, &s).await.0, axum::http::StatusCode::BAD_REQUEST);

    // The pending device's id, but with another key than the one it registered.
    let s = post(2, primary.chain_head, vec![me, (device_id, &ghost)], me);
    assert_eq!(submit(&app, primary.account_id, &caller, &s).await.0, axum::http::StatusCode::BAD_REQUEST);

    // Signed by a key that is not in the previous list.
    let s = post(2, primary.chain_head, vec![me, (device_id, &identity)], (device_id, &identity));
    assert_eq!(submit(&app, primary.account_id, &caller, &s).await.0, axum::http::StatusCode::BAD_REQUEST);

    // Wrong previous head, wrong version.
    let s = post(2, [9; 32], vec![me, (device_id, &identity)], me);
    assert_eq!(submit(&app, primary.account_id, &caller, &s).await.0, axum::http::StatusCode::BAD_REQUEST);
    let s = post(5, primary.chain_head, vec![me, (device_id, &identity)], me);
    assert_eq!(submit(&app, primary.account_id, &caller, &s).await.0, axum::http::StatusCode::BAD_REQUEST);

    // Nothing above changed anything: the device is still pending and the chain is at version 1.
    let (_, chain) = get_json(&app, &format!("/v1/accounts/{}/device-list", primary.account_id), &caller).await;
    assert_eq!(chain.as_array().unwrap().len(), 1);

    // The right statement works once, and replaying it does not.
    let head = accept(&app, &primary, device_id, &identity).await;
    let replay = post(2, primary.chain_head, vec![me, (device_id, &identity)], me);
    assert_eq!(submit(&app, primary.account_id, &caller, &replay).await.0, axum::http::StatusCode::BAD_REQUEST);
    let (_, since) = get_json(&app, &format!("/v1/accounts/{}/device-list?since=1", primary.account_id), &caller).await;
    assert_eq!(since.as_array().unwrap().len(), 1);
    assert_eq!(since[0]["version"], 2);
    let _ = head;

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn a_statement_dropping_a_device_deletes_it_and_revokes_its_auth() {
    let app = app().await;
    let primary = register_account(&app).await;
    let (device_id, identity) = link_pending(&app, &primary, "Old Phone").await;
    let head = accept(&app, &primary, device_id, &identity).await;

    // The linked device removes the primary: any remaining device may sign a removal.
    let (statement, _) = signed_statement(primary.account_id, 3, head, &[(device_id, &identity)], (device_id, &identity));
    let linked = TestAccountLike { device_id, identity: &identity };
    let (status, body) = submit(&app, primary.account_id, &linked, &statement).await;
    assert_eq!(status, axum::http::StatusCode::CREATED, "{body}");

    let (probe_status, _) = get_json(&app, &format!("/v1/devices/{device_id}/prekey-bundle"), &like(&primary)).await;
    assert_eq!(probe_status, axum::http::StatusCode::UNAUTHORIZED, "the removed device must no longer authenticate");

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn a_device_from_a_different_account_cannot_submit_a_statement() {
    let app = app().await;
    let primary = register_account(&app).await;
    let stranger = register_account(&app).await;
    let (statement, _) = signed_statement(primary.account_id, 2, primary.chain_head, &[(primary.device_id, &primary.identity)], (stranger.device_id, &stranger.identity));
    let (status, _) = submit(&app, primary.account_id, &like(&stranger), &statement).await;
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

    let (_, pending_status) = get_json(&app, &format!("/v1/accounts/{}/pending-devices", primary.account_id), &like(&stranger)).await;
    assert!(pending_status.get("error").is_some(), "another account must not see pending devices");

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
    cleanup_account(&pool, stranger.account_id).await;
}

#[tokio::test]
async fn an_expired_code_is_rejected_and_creates_no_device() {
    let app = app().await;
    let primary = register_account(&app).await;
    let code = link_init(&app, &primary).await;

    let pool = db::connect().await;
    sqlx::query!("UPDATE pending_device_links SET expires_at = now() - interval '1 minute' WHERE code = $1", code)
        .execute(&pool)
        .await
        .unwrap();

    let (mut bundle, _) = new_device_bundle();
    bundle["code"] = json!(code);
    bundle["label"] = json!("Too Late");
    let (status, _body) = request(&app, "POST", &format!("/v1/accounts/{}/devices", primary.account_id), &[], bundle).await;
    assert!(status.is_client_error(), "an expired code must be rejected, got {status}");

    let device_count: i64 = sqlx::query_scalar!("SELECT count(*) FROM devices WHERE account_id = $1", primary.account_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(device_count, 1, "only the primary device should exist - no device from the expired code");

    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn an_unknown_code_is_rejected() {
    let app = app().await;
    let primary = register_account(&app).await;

    let (mut bundle, _) = new_device_bundle();
    bundle["code"] = json!("not-a-real-code");
    bundle["label"] = json!("Nope");
    let (status, _body) = request(&app, "POST", &format!("/v1/accounts/{}/devices", primary.account_id), &[], bundle).await;
    assert!(status.is_client_error());

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn a_device_from_a_different_account_cannot_init_a_link_for_this_one() {
    let app = app().await;
    let primary = register_account(&app).await;
    let stranger = register_account(&app).await;

    let path = format!("/v1/accounts/{}/devices/link-init", primary.account_id);
    let (ts, sig) = sign(&stranger.identity, "POST", &path, b"");
    let headers = auth_headers(stranger.device_id, ts, sig);
    let (status, _body) = request(&app, "POST", &path, &as_refs(&headers), json!(null)).await;
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
    cleanup_account(&pool, stranger.account_id).await;
}

#[tokio::test]
async fn pending_devices_nobody_accepted_are_purged_and_the_count_is_capped() {
    let app = app().await;
    let primary = register_account(&app).await;
    let mut ids = vec![];
    for n in 0..5 {
        ids.push(link_pending(&app, &primary, &format!("d{n}")).await.0);
    }
    let code = link_init(&app, &primary).await;
    let (mut bundle, _) = new_device_bundle();
    bundle["code"] = json!(code);
    bundle["label"] = json!("one too many");
    let (status, _) = request(&app, "POST", &format!("/v1/accounts/{}/devices", primary.account_id), &[], bundle).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "a sixth pending device must be refused");

    let pool = db::connect().await;
    sqlx::query!("UPDATE devices SET created_at = now() - interval '2 hours' WHERE account_id = $1 AND NOT active", primary.account_id)
        .execute(&pool)
        .await
        .unwrap();
    db::purge_expired(&pool, 30).await.unwrap();
    let left: i64 = sqlx::query_scalar!("SELECT count(*) FROM devices WHERE account_id = $1", primary.account_id).fetch_one(&pool).await.unwrap().unwrap_or(0);
    assert_eq!(left, 1, "stale pending devices go, the registered one stays");

    cleanup_account(&pool, primary.account_id).await;
}
