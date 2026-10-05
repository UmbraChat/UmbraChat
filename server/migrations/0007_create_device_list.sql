-- Signed device list: each statement is the account's full device set, signed by a device from
-- the previous statement (see src/device_list.rs). `bytes` and `signature` are stored exactly as
-- the client signed them. A device whose statement has not been signed yet is pending (active =
-- false): it is not listed, cannot authenticate, has no servable prekey bundle and receives nothing.
ALTER TABLE devices ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE device_list_statements (
    account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    bytes BYTEA NOT NULL,
    signature BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, version)
);
