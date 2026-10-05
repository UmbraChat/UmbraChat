use sqlx::PgPool;

pub async fn connect() -> PgPool {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    PgPool::connect(&database_url)
        .await
        .expect("failed to connect to Postgres")
}

/// Drops queued messages older than `message_ttl_days` (a device that never comes back
/// would otherwise keep its queue forever) and device-link codes past their expiry.
pub async fn purge_expired(pool: &PgPool, message_ttl_days: i64) -> Result<u64, sqlx::Error> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(message_ttl_days);
    let messages = sqlx::query!("DELETE FROM messages WHERE created_at < $1", cutoff)
        .execute(pool)
        .await?
        .rows_affected();
    sqlx::query!("DELETE FROM pending_device_links WHERE expires_at < now()").execute(pool).await?;
    // A device nobody accepted within the hour was never going to be.
    sqlx::query!("DELETE FROM devices WHERE NOT active AND created_at < now() - interval '1 hour'").execute(pool).await?;
    Ok(messages)
}
