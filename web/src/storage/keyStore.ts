import type { IdentityBundle } from "../crypto/identity";
import { encryptForStorage, decryptFromStorage } from "../crypto/vault";

const DB_NAME = "umbrachat";
const DB_VERSION = 2;
const IDENTITY_STORE = "identity";
const SESSION_STORE = "sessions";
const RECORD_KEY = "self";

export interface LocalAccount {
  accountId: string;
  deviceId: string;
  identity: IdentityBundle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAccount(): Promise<LocalAccount | undefined> {
  const db = await openDb();
  const raw = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(IDENTITY_STORE, "readonly").objectStore(IDENTITY_STORE).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return decryptFromStorage<LocalAccount>(raw);
}

export async function saveAccount(account: LocalAccount): Promise<void> {
  const db = await openDb();
  const stored = await encryptForStorage(account);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDENTITY_STORE, "readwrite");
    tx.objectStore(IDENTITY_STORE).put(stored, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Runs `change` while no other read-modify-write of the account record runs, in this tab or
 * another (prekey rotation, turning local encryption on or off): otherwise one would save over
 * the other's result and could lose private keys the server still hands out. */
export function withAccountLock<T>(change: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request("umbrachat-account", change) : change();
}

export async function loadSession(contactId: string): Promise<Uint8Array | undefined> {
  const db = await openDb();
  const raw = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(SESSION_STORE, "readonly").objectStore(SESSION_STORE).get(contactId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return decryptFromStorage<Uint8Array>(raw);
}

export async function saveSession(contactId: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  const stored = await encryptForStorage(bytes);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).put(stored, contactId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Every contact id with a stored session - needed to migrate all of them
 * when encryption is enabled/disabled (there's no other way to enumerate an
 * IndexedDB store's keys than asking it directly). */
export async function listSessionContactIds(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(SESSION_STORE, "readonly").objectStore(SESSION_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}
