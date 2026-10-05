mod common;

use common::{app, cleanup_account, register_account};
use umbrachat_server::db;

#[tokio::test]
async fn purge_drops_only_messages_past_the_ttl() {
    let app = app().await;
    let alice = register_account(&app).await;
    let bob = register_account(&app).await;
    let pool = db::connect().await;

    for (label, age_days) in [("old", 31), ("fresh", 1)] {
        sqlx::query!(
            "INSERT INTO messages (sender_device_id, sender_account_id, recipient_device_id, ciphertext, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(days => $5))",
            alice.device_id,
            alice.account_id,
            bob.device_id,
            label.as_bytes(),
            age_days,
        )
        .execute(&pool)
        .await
        .unwrap();
    }

    db::purge_expired(&pool, 30).await.unwrap();

    let left: Vec<Vec<u8>> = sqlx::query_scalar!("SELECT ciphertext FROM messages WHERE recipient_device_id = $1", bob.device_id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(left, vec![b"fresh".to_vec()]);

    cleanup_account(&pool, alice.account_id).await;
    cleanup_account(&pool, bob.account_id).await;
}
