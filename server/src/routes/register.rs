use axum::{extract::State, http::StatusCode, Json};
use base64::{engine::general_purpose::STANDARD, Engine};
use libsignal_protocol::{kem, IdentityKey, PublicKey};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::device_list;
use crate::error::{bad_request, server_error, ApiError};

#[derive(Deserialize)]
pub struct SignedPrekeyDto {
    pub key_id: i32,
    pub public_key: String, // base64
    pub signature: String,  // base64
}

#[derive(Deserialize)]
pub struct PrekeyDto {
    pub key_id: i32,
    pub public_key: String, // base64
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub identity_public_key: String, // base64
    pub registration_id: i32,
    pub signed_prekey: SignedPrekeyDto,
    // Post-quantum prekey, mandatory: libsignal-protocol's session establishment
    // (process_prekey_bundle) requires one, this project's Signal protocol version
    // uses PQXDH rather than classic X3DH.
    pub kyber_signed_prekey: SignedPrekeyDto,
    pub one_time_prekeys: Vec<PrekeyDto>,
}

/// A signed device-list statement as it travels over HTTP.
#[derive(Deserialize)]
pub struct SignedStatementDto {
    pub statement: String, // base64
    pub signature: String, // base64
}

impl SignedStatementDto {
    pub fn decode(&self) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
        let statement = STANDARD.decode(&self.statement).map_err(|_| bad_request("statement is not valid base64"))?;
        let signature = STANDARD.decode(&self.signature).map_err(|_| bad_request("signature is not valid base64"))?;
        Ok((statement, signature))
    }
}

/// The ids are chosen by the client: they are inside the genesis statement it signs, which
/// cannot be built before them.
#[derive(Deserialize)]
pub struct RegisterBody {
    pub account_id: Uuid,
    pub device_id: Uuid,
    pub device_list: SignedStatementDto,
    #[serde(flatten)]
    pub bundle: RegisterRequest,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub account_id: Uuid,
    pub device_id: Uuid,
}

const MAX_ONE_TIME_PREKEYS: usize = 100;

/// A `RegisterRequest`'s fields, decoded from base64 and signature-verified
/// against its own identity key - shared by `/v1/register` (new account) and
/// `devices::complete_link` (new device on an existing account), so the
/// validation rules can't drift between the two.
pub struct DecodedBundle {
    pub identity_key_bytes: Vec<u8>,
    pub registration_id: i32,
    pub signed_prekey_key_id: i32,
    pub signed_prekey_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
    pub kyber_signed_prekey_key_id: i32,
    pub kyber_public_key_bytes: Vec<u8>,
    pub kyber_signature_bytes: Vec<u8>,
    pub one_time_prekeys: Vec<(i32, Vec<u8>)>,
}

/// Decodes a signed prekey (`kyber` for the post-quantum one) and checks that `identity_key`
/// signed it. `field` names it in error messages. Shared by registration and rotation.
pub fn decode_signed_prekey(identity_key: &IdentityKey, dto: &SignedPrekeyDto, field: &str, kyber: bool) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let public_key = STANDARD
        .decode(&dto.public_key)
        .map_err(|_| bad_request(&format!("{field}.public_key is not valid base64")))?;
    let signature = STANDARD
        .decode(&dto.signature)
        .map_err(|_| bad_request(&format!("{field}.signature is not valid base64")))?;
    let valid_key = if kyber { kem::PublicKey::deserialize(&public_key).is_ok() } else { PublicKey::deserialize(&public_key).is_ok() };
    if !valid_key {
        return Err(bad_request(&format!("{field}.public_key is not a valid key")));
    }
    if !identity_key.public_key().verify_signature(&public_key, &signature) {
        return Err(bad_request(&format!("{field} signature does not verify against identity_public_key")));
    }
    Ok((public_key, signature))
}

pub fn validate_bundle(req: &RegisterRequest) -> Result<DecodedBundle, ApiError> {
    let identity_key_bytes = STANDARD
        .decode(&req.identity_public_key)
        .map_err(|_| bad_request("identity_public_key is not valid base64"))?;
    let identity_key = IdentityKey::decode(&identity_key_bytes)
        .map_err(|_| bad_request("identity_public_key is not a valid identity key"))?;

    let (signed_prekey_bytes, signature_bytes) = decode_signed_prekey(&identity_key, &req.signed_prekey, "signed_prekey", false)?;
    let (kyber_public_key_bytes, kyber_signature_bytes) = decode_signed_prekey(&identity_key, &req.kyber_signed_prekey, "kyber_signed_prekey", true)?;

    if req.one_time_prekeys.len() > MAX_ONE_TIME_PREKEYS {
        return Err(bad_request("too many one_time_prekeys in a single registration"));
    }

    let mut one_time_prekeys = Vec::with_capacity(req.one_time_prekeys.len());
    for prekey in &req.one_time_prekeys {
        let bytes = STANDARD
            .decode(&prekey.public_key)
            .map_err(|_| bad_request("a one_time_prekeys public_key is not valid base64"))?;
        PublicKey::deserialize(&bytes).map_err(|_| bad_request("a one_time_prekeys public_key is not a valid key"))?;
        one_time_prekeys.push((prekey.key_id, bytes));
    }

    Ok(DecodedBundle {
        identity_key_bytes,
        registration_id: req.registration_id,
        signed_prekey_key_id: req.signed_prekey.key_id,
        signed_prekey_bytes,
        signature_bytes,
        kyber_signed_prekey_key_id: req.kyber_signed_prekey.key_id,
        kyber_public_key_bytes,
        kyber_signature_bytes,
        one_time_prekeys,
    })
}

/// Inserts a validated bundle's identity/prekey rows under `device_id`, which
/// the caller must have already created.
pub async fn insert_device_bundle(tx: &mut Transaction<'_, Postgres>, device_id: Uuid, bundle: &DecodedBundle) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO identity_keys (device_id, public_key, registration_id) VALUES ($1, $2, $3)",
        device_id,
        bundle.identity_key_bytes,
        bundle.registration_id,
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| server_error())?;

    sqlx::query!(
        "INSERT INTO signed_prekeys (device_id, key_id, public_key, signature) VALUES ($1, $2, $3, $4)",
        device_id,
        bundle.signed_prekey_key_id,
        bundle.signed_prekey_bytes,
        bundle.signature_bytes,
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| server_error())?;

    sqlx::query!(
        "INSERT INTO kyber_signed_prekeys (device_id, key_id, public_key, signature) VALUES ($1, $2, $3, $4)",
        device_id,
        bundle.kyber_signed_prekey_key_id,
        bundle.kyber_public_key_bytes,
        bundle.kyber_signature_bytes,
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| server_error())?;

    for (key_id, public_key) in &bundle.one_time_prekeys {
        sqlx::query!(
            "INSERT INTO prekeys (device_id, key_id, public_key) VALUES ($1, $2, $3)",
            device_id,
            key_id,
            public_key,
        )
        .execute(&mut **tx)
        .await
        .map_err(|_| server_error())?;
    }

    Ok(())
}

pub async fn register(
    State(pool): State<PgPool>,
    Json(req): Json<RegisterBody>,
) -> Result<(StatusCode, Json<RegisterResponse>), ApiError> {
    let bundle = validate_bundle(&req.bundle)?;

    let (statement_bytes, statement_signature) = req.device_list.decode()?;
    let chain = device_list::verify_next(None, &statement_bytes, &statement_signature).map_err(bad_request)?;
    let first = &chain.devices[0];
    if chain.account_id != req.account_id || first.device_id != req.device_id || first.identity_key != bundle.identity_key_bytes {
        return Err(bad_request("the device list does not match this registration"));
    }

    let mut tx = pool.begin().await.map_err(|_| server_error())?;

    sqlx::query!("INSERT INTO accounts (id) VALUES ($1)", req.account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => bad_request("account id already in use"),
            _ => server_error(),
        })?;

    sqlx::query!("INSERT INTO devices (id, account_id, label) VALUES ($1, $2, 'Primary')", req.device_id, req.account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db) if db.is_unique_violation() => bad_request("device id already in use"),
            _ => server_error(),
        })?;

    insert_device_bundle(&mut tx, req.device_id, &bundle).await?;
    super::device_chain::insert_statement(&mut tx, chain.account_id, chain.version, &statement_bytes, &statement_signature).await?;

    tx.commit().await.map_err(|_| server_error())?;

    Ok((StatusCode::CREATED, Json(RegisterResponse { account_id: req.account_id, device_id: req.device_id })))
}
