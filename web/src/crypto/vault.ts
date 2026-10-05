import { toBase64, fromBase64 } from "../api/codec";
import { loadAccount, saveAccount, loadSession, saveSession, listSessionContactIds, withAccountLock } from "../storage/keyStore";
import { loadMessages, saveMessages, listMessageContactIds } from "../storage/messageStore";
import { loadAllGroups, saveGroup } from "../storage/groupStore";

const SALT_KEY = "umbrachat:vaultSalt";
const ENABLED_KEY = "umbrachat:vaultEnabled";
const KEY_UNLOCK_KEY = "umbrachat:vaultKeyUnlock";
const PBKDF2_ITERATIONS = 600_000;

interface EncryptedBlob {
  __encrypted: true;
  iv: string;
  data: string;
}

function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  return typeof value === "object" && value !== null && (value as { __encrypted?: unknown }).__encrypted === true;
}

/** Recursively replaces every Uint8Array with a base64 marker, so the result
 * is JSON-serializable - IndexedDB stores structured objects directly, but
 * once we're encrypting we need one flat plaintext buffer to hand to AES-GCM.
 * Exported for crypto/backup.ts, which needs the exact same walk. */
export function replaceBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __bytes: toBase64(value) };
  if (Array.isArray(value)) return value.map(replaceBytes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceBytes(v);
    return out;
  }
  return value;
}

export function restoreBytes(value: unknown): unknown {
  if (value && typeof value === "object" && "__bytes" in value) return fromBase64((value as { __bytes: string }).__bytes);
  if (Array.isArray(value)) return value.map(restoreBytes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreBytes(v);
    return out;
  }
  return value;
}

/** Held only here, only in memory - never written to localStorage/IndexedDB.
 * A fresh page load always starts with this unset (see screens/Unlock.tsx). */
let activeKey: CryptoKey | null = null;

export function isVaultActive(): boolean {
  return activeKey !== null;
}

/** Whether the feature is turned on at all - a plain, non-secret flag, safe
 * to read before anything is unlocked (unlike activeKey, this survives reload). */
export function isEncryptionEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "1";
}

/** Exported for crypto/backup.ts, which needs the exact same PBKDF2 shape for
 * its own (independent) passphrase - see the plan's Decisions for why a
 * backup's passphrase is never the same key as the local-encryption one. */
export async function deriveKey(passphrase: string, salt: Uint8Array, extractable = false): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    // Not extractable by default - the raw key bytes can never be read back out, even by this
    // app's own code. Only addUnlockKey asks for an extractable copy, to wrap it at once.
    extractable,
    ["encrypt", "decrypt"],
  );
}

/** Passthrough when the vault is off/locked, so every store's save/load
 * keeps working completely unchanged for the (default) encryption-off case. */
export async function encryptForStorage<T>(value: T): Promise<T | EncryptedBlob> {
  if (!activeKey) return value;
  const plaintext = new TextEncoder().encode(JSON.stringify(replaceBytes(value)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, activeKey, plaintext);
  return { __encrypted: true, iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptFromStorage<T>(stored: unknown): Promise<T | undefined> {
  if (stored === undefined) return undefined;
  if (!isEncryptedBlob(stored)) return stored as T; // plaintext - encryption off, or a legacy pre-migration record
  if (!activeKey) throw new Error("vault is locked");
  const iv = fromBase64(stored.iv);
  const ciphertext = fromBase64(stored.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, activeKey, ciphertext as BufferSource);
  return restoreBytes(JSON.parse(new TextDecoder().decode(plaintext))) as T;
}

/**
 * Derives the key from a passphrase and verifies it's correct by calling
 * `verify` (the caller passes something like `loadAccount`, which will now
 * transparently decrypt through the tentatively-active key) - AES-GCM's own
 * auth tag failing on a wrong key IS the password check, no separate stored
 * verifier needed. Takes `verify` as a parameter instead of importing
 * keyStore directly, so this module doesn't depend on any specific store.
 */
export async function unlock(passphrase: string, verify: () => Promise<unknown>): Promise<boolean> {
  const saltB64 = localStorage.getItem(SALT_KEY);
  if (!saltB64) return false;
  return activateIfValid(await deriveKey(passphrase, fromBase64(saltB64)), verify);
}

async function activateIfValid(key: CryptoKey, verify: () => Promise<unknown>): Promise<boolean> {
  activeKey = key;
  try {
    const result = await verify();
    if (result === undefined) {
      activeKey = null;
      return false;
    }
    return true;
  } catch {
    activeKey = null; // wrong key - GCM auth tag check failed
    return false;
  }
}

/**
 * Unlocking with a security key or the device's own lock (fingerprint, face, PIN), in addition
 * to the passphrase, never instead of it. The authenticator's WebAuthn PRF extension turns a
 * stored salt into a secret only it can compute, after verifying the user; that secret wraps
 * the vault key, and only the wrapped copy is stored, useless without the authenticator. Whoever
 * passes the authenticator's own check (including a device PIN) can open the vault with it.
 */
export interface KeyUnlock {
  credentialId: string; // base64
  name: string; // chosen by the user, to tell keys apart
  salt: string; // base64, the PRF input
  iv: string; // base64
  wrappedKey: string; // base64, the vault key wrapped under the PRF-derived key
}

const NO_PRF = "this browser or this authenticator cannot derive an unlock key (no WebAuthn PRF support)";
const MAX_KEY_NAME = 40;

/** Every registered key, oldest first. A record from before several keys were allowed is read as a one-key list. */
export function listUnlockKeys(): KeyUnlock[] {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY_UNLOCK_KEY) ?? "[]");
    return Array.isArray(stored) ? stored : [{ ...stored, name: "Security key" }];
  } catch {
    return [];
  }
}

function saveUnlockKeys(keys: KeyUnlock[]): void {
  if (keys.length) localStorage.setItem(KEY_UNLOCK_KEY, JSON.stringify(keys));
  else localStorage.removeItem(KEY_UNLOCK_KEY);
}

export function isKeyUnlockEnabled(): boolean {
  return listUnlockKeys().length > 0;
}

/** Whether this browser has WebAuthn at all; PRF support is only known once an authenticator answers. */
export function isKeyUnlockSupported(): boolean {
  return typeof window.PublicKeyCredential !== "undefined";
}

export function renameUnlockKey(credentialId: string, name: string): void {
  saveUnlockKeys(listUnlockKeys().map((k) => (k.credentialId === credentialId ? { ...k, name: name.trim().slice(0, MAX_KEY_NAME) || k.name } : k)));
}

export function removeUnlockKey(credentialId: string): void {
  saveUnlockKeys(listUnlockKeys().filter((k) => k.credentialId !== credentialId));
}

async function wrappingKey(prfOutput: BufferSource): Promise<CryptoKey> {
  const secret = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("umbrachat vault key wrap v1") },
    secret,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

function prfOutput(credential: PublicKeyCredential): BufferSource | undefined {
  return credential.getClientExtensionResults().prf?.results?.first;
}

const base64url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** One prompt for any of the given keys, each with its own salt; returns which key answered and its secret. */
async function evaluatePrf(keys: Pick<KeyUnlock, "credentialId" | "salt">[]): Promise<{ credentialId: string; output: BufferSource }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: keys.map((k) => ({ type: "public-key", id: fromBase64(k.credentialId) as BufferSource })),
      userVerification: "required",
      extensions: { prf: { evalByCredential: Object.fromEntries(keys.map((k) => [base64url(k.credentialId), { first: fromBase64(k.salt) as BufferSource }])) } },
    },
  })) as PublicKeyCredential | null;
  const output = assertion && prfOutput(assertion);
  if (!output) throw new Error(NO_PRF);
  return { credentialId: toBase64(new Uint8Array(assertion.rawId)), output };
}

/**
 * Registers an authenticator that can unlock the vault. Asks for the passphrase again: the
 * active key cannot be exported, so the same key is derived anew in a form that can be wrapped,
 * and checked against the active one before anything is stored. It also keeps someone who finds
 * the app unlocked from adding an authenticator of their own.
 */
export async function addUnlockKey(passphrase: string, name: string): Promise<void> {
  const saltB64 = localStorage.getItem(SALT_KEY);
  if (!activeKey || !saltB64) throw new Error("turn on local encryption first");
  const vaultKey = await deriveKey(passphrase, fromBase64(saltB64), true);
  const probeIv = crypto.getRandomValues(new Uint8Array(12));
  const probe = await crypto.subtle.encrypt({ name: "AES-GCM", iv: probeIv }, activeKey, new Uint8Array(16));
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: probeIv }, vaultKey, probe);
  } catch {
    throw new Error("wrong passphrase");
  }
  const capabilities = await PublicKeyCredential.getClientCapabilities?.().catch(() => undefined);
  if (capabilities?.["extension:prf"] === false) throw new Error(NO_PRF);

  const existing = listUnlockKeys();
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "UmbraChat" },
      // Generic names: a passkey manager that syncs would otherwise keep an account id.
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "UmbraChat", displayName: "UmbraChat local unlock" },
      // No server checks this ceremony: what matters is the PRF secret, which only the authenticator can compute.
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
      // The same authenticator twice would only add a duplicate entry.
      excludeCredentials: existing.map((k) => ({ type: "public-key", id: fromBase64(k.credentialId) as BufferSource })),
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no authenticator was registered");
  const credentialId = new Uint8Array(credential.rawId);
  // Some authenticators only compute PRF when used, not when created.
  const output = prfOutput(credential) ?? (credential.getClientExtensionResults().prf?.enabled ? (await evaluatePrf([{ credentialId: toBase64(credentialId), salt: toBase64(prfSalt) }])).output : undefined);
  if (!output) throw new Error(NO_PRF);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, await wrappingKey(output), { name: "AES-GCM", iv });
  const record: KeyUnlock = {
    credentialId: toBase64(credentialId),
    name: name.trim().slice(0, MAX_KEY_NAME) || `Security key ${existing.length + 1}`,
    salt: toBase64(prfSalt),
    iv: toBase64(iv),
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
  saveUnlockKeys([...listUnlockKeys(), record]);
}

/** Unlocks with whichever registered authenticator answers. False when its secret does not open this vault; throws when the authenticator refused or was cancelled. */
export async function unlockWithKey(verify: () => Promise<unknown>): Promise<boolean> {
  const keys = listUnlockKeys();
  if (!keys.length) return false;
  const { credentialId, output } = await evaluatePrf(keys);
  const record = keys.find((k) => k.credentialId === credentialId);
  if (!record) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.unwrapKey(
      "raw",
      fromBase64(record.wrappedKey) as BufferSource,
      await wrappingKey(output),
      { name: "AES-GCM", iv: fromBase64(record.iv) as BufferSource },
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return false;
  }
  return activateIfValid(key, verify);
}

/**
 * Turns encryption on for the first time. Ordering matters: every existing
 * record is read out *before* the key is activated (so those reads hit the
 * plaintext passthrough), then the key/flag are set, then everything is
 * written back out (now hitting the encrypt path) - doing this in the wrong
 * order means trying to decrypt-with-the-new-key data that's still in the
 * old plaintext shape, or the reverse.
 */
export async function enableEncryption(passphrase: string): Promise<void> {
  return withAccountLock(async () => {
    const account = await loadAccount();
    const sessionIds = await listSessionContactIds();
    const sessions = await Promise.all(sessionIds.map(async (id) => [id, await loadSession(id)] as const));
    const messageIds = await listMessageContactIds();
    const messages = await Promise.all(messageIds.map(async (id) => [id, await loadMessages(id)] as const));
    const groups = await loadAllGroups();

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    localStorage.setItem(SALT_KEY, toBase64(salt));
    localStorage.setItem(ENABLED_KEY, "1");
    activeKey = key;

    if (account) await saveAccount(account);
    for (const [id, bytes] of sessions) if (bytes) await saveSession(id, bytes);
    for (const [id, msgs] of messages) await saveMessages(id, msgs);
    for (const group of groups) await saveGroup(group);
  });
}

/** Reverse of enableEncryption: read everything while still encrypted, THEN
 * clear the key/flag, THEN write everything back out as plaintext. */
export async function disableEncryption(): Promise<void> {
  return withAccountLock(async () => {
    const account = await loadAccount();
    const sessionIds = await listSessionContactIds();
    const sessions = await Promise.all(sessionIds.map(async (id) => [id, await loadSession(id)] as const));
    const messageIds = await listMessageContactIds();
    const messages = await Promise.all(messageIds.map(async (id) => [id, await loadMessages(id)] as const));
    const groups = await loadAllGroups();

    activeKey = null;
    localStorage.removeItem(SALT_KEY);
    localStorage.removeItem(ENABLED_KEY);
    localStorage.removeItem(KEY_UNLOCK_KEY);

    if (account) await saveAccount(account);
    for (const [id, bytes] of sessions) if (bytes) await saveSession(id, bytes);
    for (const [id, msgs] of messages) await saveMessages(id, msgs);
    for (const group of groups) await saveGroup(group);
  });
}
