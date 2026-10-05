import { signWithIdentity, verifySignature } from "./identity";

/**
 * Signed device list. Each account has a chain of statements, each one the full set of its
 * devices (id and identity key) signed by a device that was in the previous statement.
 * Whoever holds a pin (account, version, head) can check any later statement without trusting
 * the server that relays it: the server cannot add, hide or swap a device on its own.
 *
 * A statement is a fixed binary layout, signed and stored as exact bytes, never re-encoded:
 *   prefix | account_id(16) | version(u32 BE) | prev_head(32) | signer_device_id(16) | count(u16 BE)
 *          | count x ( device_id(16) | key_len(u8) | identity_key )
 * The prefix keeps this signature from being reused as any other signature of the same key
 * (the server's request signatures are signed by the same identity keys).
 * `head` = SHA-256(statement bytes | signature) and is what the next statement points to.
 * server/src/device_list.rs reads the same layout.
 */
export const STATEMENT_PREFIX = "umbrachat-device-list-v1\n";
export const MAX_DEVICES = 20;
const KEY_LENGTH = 33; // serialized libsignal public key: type byte + 32
const HASH_LENGTH = 32;
const ZERO_HEAD = new Uint8Array(HASH_LENGTH);

export interface DeviceEntry {
  deviceId: string;
  identityKey: Uint8Array;
}

export interface Statement {
  accountId: string;
  version: number;
  prevHead: Uint8Array;
  signerDeviceId: string;
  devices: DeviceEntry[];
}

export interface SignedStatement {
  bytes: Uint8Array;
  signature: Uint8Array;
}

/** What a verifier remembers about an account's chain. */
export interface ChainState {
  accountId: string;
  version: number;
  head: Uint8Array;
  devices: DeviceEntry[];
}

const encoder = new TextEncoder();

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("not a UUID");
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function encodeStatement(s: Statement): Uint8Array {
  if (s.devices.length > MAX_DEVICES) throw new Error("too many devices");
  const parts: number[] = [...encoder.encode(STATEMENT_PREFIX), ...uuidToBytes(s.accountId)];
  parts.push((s.version >>> 24) & 255, (s.version >>> 16) & 255, (s.version >>> 8) & 255, s.version & 255);
  parts.push(...s.prevHead, ...uuidToBytes(s.signerDeviceId), (s.devices.length >> 8) & 255, s.devices.length & 255);
  for (const d of s.devices) {
    if (d.identityKey.length !== KEY_LENGTH) throw new Error("bad identity key length");
    parts.push(...uuidToBytes(d.deviceId), d.identityKey.length, ...d.identityKey);
  }
  return Uint8Array.from(parts);
}

/** Strict: any deviation from the layout (prefix, lengths, trailing bytes) is an error. */
export function decodeStatement(bytes: Uint8Array): Statement {
  const prefix = encoder.encode(STATEMENT_PREFIX);
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (at + n > bytes.length) throw new Error("statement is truncated");
    const out = bytes.slice(at, at + n);
    at += n;
    return out;
  };
  if (!sameBytes(take(prefix.length), prefix)) throw new Error("not a device list statement");
  const accountId = bytesToUuid(take(16));
  const v = take(4);
  const version = ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
  const prevHead = take(HASH_LENGTH);
  const signerDeviceId = bytesToUuid(take(16));
  const c = take(2);
  const count = (c[0] << 8) | c[1];
  if (count === 0 || count > MAX_DEVICES) throw new Error("bad device count");
  const devices: DeviceEntry[] = [];
  for (let i = 0; i < count; i++) {
    const deviceId = bytesToUuid(take(16));
    if (take(1)[0] !== KEY_LENGTH) throw new Error("bad identity key length");
    devices.push({ deviceId, identityKey: take(KEY_LENGTH) });
  }
  if (at !== bytes.length) throw new Error("trailing bytes after statement");
  return { accountId, version, prevHead, signerDeviceId, devices };
}

export async function signStatement(s: Statement, signerPrivateKey: number[]): Promise<SignedStatement> {
  const bytes = encodeStatement(s);
  return { bytes, signature: await signWithIdentity(signerPrivateKey, bytes) };
}

export async function headOf(s: SignedStatement): Promise<Uint8Array> {
  const joined = Uint8Array.from([...s.bytes, ...s.signature]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

/** The first statement of an account: its only device lists itself and signs. */
export function genesisStatement(accountId: string, device: DeviceEntry): Statement {
  return { accountId, version: 1, prevHead: ZERO_HEAD, signerDeviceId: device.deviceId, devices: [device] };
}

/**
 * Verifies `statements` (consecutive, oldest first) on top of `pin`, or from the genesis when
 * there is no pin, and returns the resulting state. Throws on anything that is not a valid
 * continuation: wrong account, a version that skips or goes back, a broken link, a signer that
 * was not in the previous list, a changed key for a device that stays, a bad signature.
 * An empty list returns the pin unchanged (nothing new is not an error here: whether the server
 * is holding something back is for the caller to judge, see the head carried in messages).
 */
export async function verifyChain(statements: SignedStatement[], pin?: ChainState): Promise<ChainState> {
  let state = pin;
  for (const signed of statements) {
    const s = decodeStatement(signed.bytes);
    const expectedVersion = state ? state.version + 1 : 1;
    if (state && s.accountId !== state.accountId) throw new Error("statement belongs to another account");
    if (s.version !== expectedVersion) throw new Error(`unexpected version ${s.version}, expected ${expectedVersion}`);
    if (new Set(s.devices.map((d) => d.deviceId)).size !== s.devices.length) throw new Error("duplicate device");
    if (state && !sameBytes(s.prevHead, state.head)) throw new Error("statement does not follow the pinned head");
    if (!state && !sameBytes(s.prevHead, ZERO_HEAD)) throw new Error("genesis must have an empty previous head");

    // The signer's key comes from the list before this statement, never from the statement itself
    // (except at genesis, where there is nothing before: the only device vouches for itself).
    const trusted = state ? state.devices : s.devices;
    if (!state && s.devices.length !== 1) throw new Error("genesis lists exactly one device");
    const signer = trusted.find((d) => d.deviceId === s.signerDeviceId);
    if (!signer) throw new Error("signer was not in the previous list");
    if (!(await verifySignature(signer.identityKey, signed.bytes, signed.signature))) throw new Error("signature does not verify");

    if (state) {
      for (const d of s.devices) {
        const before = state.devices.find((p) => p.deviceId === d.deviceId);
        if (before && !sameBytes(before.identityKey, d.identityKey)) throw new Error("a device's key cannot change");
      }
    }
    state = { accountId: s.accountId, version: s.version, head: await headOf(signed), devices: s.devices };
  }
  if (!state) throw new Error("no statements and no pin");
  return state;
}
