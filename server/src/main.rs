use umbrachat_server::{db, routes};

#[tokio::main]
async fn main() {
    let vapid_private_key = std::env::var("VAPID_PRIVATE_KEY").expect("VAPID_PRIVATE_KEY must be set");
    // A malformed key would otherwise disable push notifications without any error.
    web_push::VapidSignatureBuilder::from_base64_no_sub(&vapid_private_key)
        .expect("VAPID_PRIVATE_KEY is not a valid base64url key; generate one with `npx web-push generate-vapid-keys`");
    let pool = db::connect().await;
    sqlx::migrate!().run(&pool).await.expect("failed to run database migrations");
    let message_ttl_days: i64 = match std::env::var("MESSAGE_TTL_DAYS").ok().filter(|v| !v.is_empty()) {
        Some(v) => v.parse().ok().filter(|d| *d >= 1).expect("MESSAGE_TTL_DAYS must be a whole number of days, at least 1"),
        None => 30,
    };
    let purge_pool = pool.clone();
    tokio::spawn(async move {
        loop {
            if let Err(err) = db::purge_expired(&purge_pool, message_ttl_days).await {
                eprintln!("purging expired data failed: {err}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
    let app = routes::router(pool, vapid_private_key);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind to port 3000");
    println!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.expect("server error");
}
