import type { IdentityBundle } from "../crypto/identity";

export function toBase64(bytes: Uint8Array | number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from the server become storage keys, session addresses (`account:device`) and URL paths: only real UUIDs pass. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** The base64-encoded JSON shape both /v1/register and device-linking's complete step expect. */
export function identityBundleToJson(identity: IdentityBundle) {
  return {
    identity_public_key: toBase64(identity.identity_public_key),
    registration_id: identity.registration_id,
    signed_prekey: {
      key_id: identity.signed_prekey.key_id,
      public_key: toBase64(identity.signed_prekey.public_key),
      signature: toBase64(identity.signed_prekey.signature),
    },
    kyber_signed_prekey: {
      key_id: identity.kyber_signed_prekey.key_id,
      public_key: toBase64(identity.kyber_signed_prekey.public_key),
      signature: toBase64(identity.kyber_signed_prekey.signature),
    },
    one_time_prekeys: identity.one_time_prekeys.map((k) => ({
      key_id: k.key_id,
      public_key: toBase64(k.public_key),
    })),
  };
}
