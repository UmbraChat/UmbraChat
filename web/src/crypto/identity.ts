import init, { generate_identity_bundle, sign_with_identity, verify_identity_signature } from "wasm-crypto";

export interface PrekeyBundle {
  key_id: number;
  public_key: number[];
  private_key: number[];
}

export interface SignedPrekeyBundle extends PrekeyBundle {
  signature: number[];
}

export interface IdentityBundle {
  identity_public_key: number[];
  identity_private_key: number[];
  registration_id: number;
  signed_prekey: SignedPrekeyBundle;
  // Post-quantum prekey, mandatory: libsignal-protocol's session establishment
  // uses PQXDH, not classic X3DH.
  kyber_signed_prekey: SignedPrekeyBundle;
  one_time_prekeys: PrekeyBundle[];
}

let initialized: Promise<unknown> | undefined;

export async function ensureInit(): Promise<void> {
  initialized ??= init();
  await initialized;
}

export async function generateIdentity(oneTimePrekeyCount = 10): Promise<IdentityBundle> {
  await ensureInit();
  return generate_identity_bundle(oneTimePrekeyCount) as IdentityBundle;
}

export async function signWithIdentity(privateKey: number[], message: Uint8Array): Promise<Uint8Array> {
  await ensureInit();
  return sign_with_identity(Uint8Array.from(privateKey), message);
}

export async function verifySignature(identityPublicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  await ensureInit();
  return verify_identity_signature(identityPublicKey, message, signature);
}

async function toDigits(input: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input as BufferSource));
  let digits = "";
  for (const byte of bytes) {
    digits += byte.toString().padStart(3, "0");
  }
  return digits.slice(0, 30).match(/.{1,5}/g)!.join(" ");
}

/** One device's key fingerprint: what its own identity screen shows. Used to check a new device. */
export function computeSafetyNumber(identityPublicKey: number[]): Promise<string> {
  return toDigits(Uint8Array.from(identityPublicKey));
}

/**
 * Safety number of a conversation between two devices: a hash of both keys in a fixed
 * order, so both sides see the same number and one comparison covers both directions.
 */
export function computePairwiseSafetyNumber(a: ArrayLike<number>, b: ArrayLike<number>): Promise<string> {
  const [first, second] = [Uint8Array.from(a), Uint8Array.from(b)].sort((x, y) => {
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  return toDigits(Uint8Array.from([...first, ...second]));
}
