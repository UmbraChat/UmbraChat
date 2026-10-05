mod common;

use common::{accept, app, auth_headers, as_refs, cleanup_account, like, link_pending, register_account, request, sign, signed_statement, submit};
use serde_json::json;
use umbrachat_server::db;

fn subscription_body(endpoint: &str) -> serde_json::Value {
    json!({
        "endpoint": endpoint,
        "keys": { "p256dh": "BJ4zTHbV26hZ9fm8bQQ4jwtUDU36viSQZJkExrF9q0eI9OY_uGZ1e_WPvIRf2ZkaWr6etRwb4fXMOOXxhQpYMUc", "auth": "dGVzdGF1dGgxMjM0" }
    })
}

#[tokio::test]
async fn registering_a_subscription_persists_it() {
    let app = app().await;
    let primary = register_account(&app).await;

    let path = format!("/v1/devices/{}/push-subscription", primary.device_id);
    let body = subscription_body("https://example.com/push/abc");
    let raw_body = serde_json::to_vec(&body).unwrap();
    let (ts, sig) = sign(&primary.identity, "POST", &path, &raw_body);
    let headers = auth_headers(primary.device_id, ts, sig);
    let (status, _body) = request(&app, "POST", &path, &as_refs(&headers), body).await;
    assert_eq!(status, axum::http::StatusCode::NO_CONTENT);

    let pool = db::connect().await;
    let endpoint: String = sqlx::query_scalar!("SELECT endpoint FROM push_subscriptions WHERE device_id = $1", primary.device_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(endpoint, "https://example.com/push/abc");

    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn unregistering_removes_it() {
    let app = app().await;
    let primary = register_account(&app).await;

    let path = format!("/v1/devices/{}/push-subscription", primary.device_id);
    let body = subscription_body("https://example.com/push/xyz");
    let raw_body = serde_json::to_vec(&body).unwrap();
    let (ts, sig) = sign(&primary.identity, "POST", &path, &raw_body);
    let headers = auth_headers(primary.device_id, ts, sig);
    request(&app, "POST", &path, &as_refs(&headers), body).await;

    let (ts2, sig2) = sign(&primary.identity, "DELETE", &path, b"");
    let headers2 = auth_headers(primary.device_id, ts2, sig2);
    let (status, _body) = request(&app, "DELETE", &path, &as_refs(&headers2), json!(null)).await;
    assert_eq!(status, axum::http::StatusCode::NO_CONTENT);

    let pool = db::connect().await;
    let count: i64 = sqlx::query_scalar!("SELECT count(*) FROM push_subscriptions WHERE device_id = $1", primary.device_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(count, 0);

    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn a_device_cannot_manage_another_devices_subscription() {
    let app = app().await;
    let primary = register_account(&app).await;
    let stranger = register_account(&app).await;

    let path = format!("/v1/devices/{}/push-subscription", primary.device_id);
    let body = subscription_body("https://example.com/push/nope");
    let raw_body = serde_json::to_vec(&body).unwrap();
    let (ts, sig) = sign(&stranger.identity, "POST", &path, &raw_body);
    let headers = auth_headers(stranger.device_id, ts, sig);
    let (status, _body) = request(&app, "POST", &path, &as_refs(&headers), body).await;
    assert_eq!(status, axum::http::StatusCode::FORBIDDEN);

    let pool = db::connect().await;
    cleanup_account(&pool, primary.account_id).await;
    cleanup_account(&pool, stranger.account_id).await;
}

#[tokio::test]
async fn unlinking_a_device_also_removes_its_push_subscription() {
    let app = app().await;
    let primary = register_account(&app).await;

    let sub_path = format!("/v1/devices/{}/push-subscription", primary.device_id);
    let body = subscription_body("https://example.com/push/will-be-deleted");
    let raw_body = serde_json::to_vec(&body).unwrap();
    let (ts, sig) = sign(&primary.identity, "POST", &sub_path, &raw_body);
    let headers = auth_headers(primary.device_id, ts, sig);
    request(&app, "POST", &sub_path, &as_refs(&headers), body).await;

    let pool = db::connect().await;
    let before: i64 = sqlx::query_scalar!("SELECT count(*) FROM push_subscriptions WHERE device_id = $1", primary.device_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(before, 1, "subscription should exist before the removal");

    // A device removed by a signed statement takes its subscription with it.
    let (second, second_identity) = link_pending(&app, &primary, "Second").await;
    let head = accept(&app, &primary, second, &second_identity).await;
    let sub_path2 = format!("/v1/devices/{second}/push-subscription");
    let body2 = subscription_body("https://example.com/push/second");
    let (ts2, sig2) = sign(&second_identity, "POST", &sub_path2, &serde_json::to_vec(&body2).unwrap());
    let h2 = auth_headers(second, ts2, sig2);
    request(&app, "POST", &sub_path2, &as_refs(&h2), body2).await;
    let (statement, _) = signed_statement(primary.account_id, primary.chain_version + 2, head, &[(primary.device_id, &primary.identity)], (primary.device_id, &primary.identity));
    let (unlink_status, _body) = submit(&app, primary.account_id, &like(&primary), &statement).await;
    assert_eq!(unlink_status, axum::http::StatusCode::CREATED);

    let primary_left: i64 = sqlx::query_scalar!("SELECT count(*) FROM push_subscriptions WHERE device_id = $1", primary.device_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(primary_left, 1, "the device that stays keeps its subscription");
    let after: i64 = sqlx::query_scalar!("SELECT count(*) FROM push_subscriptions WHERE device_id = $1", second)
        .fetch_one(&pool)
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(after, 0, "the cascade delete must remove the subscription along with the device");

    cleanup_account(&pool, primary.account_id).await;
}

#[tokio::test]
async fn sending_a_message_to_a_subscribed_but_unreachable_device_still_succeeds() {
    // The critical best-effort property: a push notification that can never
    // possibly be delivered (nothing listens on this endpoint at all) must
    // never turn into a failed message send.
    let app = app().await;
    let sender = register_account(&app).await;
    let recipient = register_account(&app).await;

    let sub_path = format!("/v1/devices/{}/push-subscription", recipient.device_id);
    let body = subscription_body("https://127.0.0.1:1/push/unreachable");
    let raw_body = serde_json::to_vec(&body).unwrap();
    let (ts, sig) = sign(&recipient.identity, "POST", &sub_path, &raw_body);
    let headers = auth_headers(recipient.device_id, ts, sig);
    let (sub_status, _b) = request(&app, "POST", &sub_path, &as_refs(&headers), body).await;
    assert_eq!(sub_status, axum::http::StatusCode::NO_CONTENT);

    let msg_body = json!({ "recipient_device_id": recipient.device_id, "ciphertext": "aGVsbG8=" });
    let raw_msg_body = serde_json::to_vec(&msg_body).unwrap();
    let (m_ts, m_sig) = sign(&sender.identity, "POST", "/v1/messages", &raw_msg_body);
    let m_headers = auth_headers(sender.device_id, m_ts, m_sig);
    let (msg_status, msg_resp) = request(&app, "POST", "/v1/messages", &as_refs(&m_headers), msg_body).await;
    assert_eq!(msg_status, axum::http::StatusCode::CREATED, "message send must succeed even though the push notification cannot possibly be delivered: {msg_resp}");

    let pool = db::connect().await;
    cleanup_account(&pool, sender.account_id).await;
    cleanup_account(&pool, recipient.account_id).await;
}
