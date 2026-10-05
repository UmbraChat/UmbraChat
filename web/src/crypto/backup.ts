import { toBase64, fromBase64 } from "../api/codec";
import { deriveKey, replaceBytes, restoreBytes } from "./vault";
import { loadAccount, saveAccount, loadSession, saveSession, listSessionContactIds, type LocalAccount } from "../storage/keyStore";
import { loadMessages, saveMessages, listMessageContactIds, type ChatMessage } from "../storage/messageStore";
import { loadAllGroups, saveGroup, type Group } from "../storage/groupStore";
import { SERVER_URL_REQUIRED, currentServerOrigin, setServerUrl } from "../api/server";

const BACKUP_VERSION = 1;

interface Snapshot {
  account: LocalAccount | undefined;
  sessions: readonly (readonly [string, Uint8Array | undefined])[];
  messages: readonly (readonly [string, ChatMessage[]])[];
  groups: Group[];
  /** The server this account lives on, when the user chose one (absent in older backups). */
  serverUrl?: string;
}

async function gatherSnapshot(): Promise<Snapshot> {
  const account = await loadAccount();
  const sessionIds = await listSessionContactIds();
  const sessions = await Promise.all(sessionIds.map(async (id) => [id, await loadSession(id)] as const));
  const messageIds = await listMessageContactIds();
  const messages = await Promise.all(messageIds.map(async (id) => [id, await loadMessages(id)] as const));
  const groups = await loadAllGroups();
  return { account, sessions, messages, groups, serverUrl: currentServerOrigin() };
}

/**
 * Encrypts everything stored locally (identity, sessions, messages, groups)
 * into one portable file the user saves themselves - never touches the
 * server. Uses a fresh passphrase/salt independent of whatever local-
 * encryption vault state (if any) is already active - see the plan's
 * Decisions for why these stay two separate keys.
 */
export async function exportBackup(passphrase: string): Promise<Blob> {
  const snapshot = await gatherSnapshot();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(replaceBytes(snapshot)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  const file = {
    version: BACKUP_VERSION,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

/**
 * Decrypts a backup file and repopulates every local store from it, then
 * returns the restored account so the caller can boot straight into it. Only
 * meant to run on a device with no existing local account (see plan
 * Decisions) - there's no merge-with-existing-data path.
 */
export async function importBackup(file: File, passphrase: string): Promise<LocalAccount> {
  const parsed = JSON.parse(await file.text());
  if (parsed.version !== BACKUP_VERSION) throw new Error("unsupported backup file - it may be from a newer version of the app");

  const key = await deriveKey(passphrase, fromBase64(parsed.salt));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(parsed.iv) as BufferSource }, key, fromBase64(parsed.data) as BufferSource);
  } catch {
    throw new Error("wrong passphrase or corrupted backup file");
  }

  const snapshot = restoreBytes(JSON.parse(new TextDecoder().decode(plaintext))) as Snapshot;
  if (!snapshot.account) throw new Error("backup file has no account in it");

  // An instance's page talks only to its own server: an account from another one would be stranded here.
  if (!SERVER_URL_REQUIRED && snapshot.serverUrl && snapshot.serverUrl !== currentServerOrigin()) {
    throw new Error(`this backup's account lives on ${snapshot.serverUrl}: restore it there, or in UmbraChat installed on your device`);
  }
  if (SERVER_URL_REQUIRED && snapshot.serverUrl) {
    try {
      setServerUrl(snapshot.serverUrl);
    } catch {
      /* an unusable address in the file: keep whatever the user entered */
    }
  }
  await saveAccount(snapshot.account);
  for (const [id, bytes] of snapshot.sessions) if (bytes) await saveSession(id, bytes);
  for (const [id, msgs] of snapshot.messages) await saveMessages(id, msgs);
  for (const group of snapshot.groups) await saveGroup(group);

  return snapshot.account;
}
