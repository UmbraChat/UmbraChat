import { encryptForStorage, decryptFromStorage } from "../crypto/vault";

const DB_NAME = "umbrachat-messages";
const STORE_NAME = "messages";

export interface ChatFile {
  filename: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface ChatMessage {
  id: string;
  direction: "sent" | "received";
  text: string;
  status: "sent" | "delivered" | "read" | "opened";
  createdAt: string;
  file?: ChatFile;
  timerSeconds?: number;
  expiresAt?: string;
  destructOnOpen?: boolean;
  /** Only set on received group messages - which member sent it. A 1:1
   * conversation's sender is already implicit from the open contact. */
  senderAccountId?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadMessages(contactId: string): Promise<ChatMessage[]> {
  const db = await openDb();
  const raw = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(contactId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return (await decryptFromStorage<ChatMessage[]>(raw)) ?? [];
}

export async function saveMessages(contactId: string, messages: ChatMessage[]): Promise<void> {
  const db = await openDb();
  const stored = await encryptForStorage(messages);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(stored, contactId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One chain per bucket: a send, a poll and a receipt all read-modify-write the same history,
// and an interleaved pair silently drops one of the two changes.
const chains = new Map<string, Promise<unknown>>();

/**
 * Applies `change` to a bucket with no other update in between. `change` edits the array in
 * place and returns nothing, or returns a replacement; return `false` to skip the write.
 * Never await the network inside `change`: it holds up every other writer of that bucket.
 */
export function updateMessages(id: string, change: (messages: ChatMessage[]) => ChatMessage[] | void | false): Promise<ChatMessage[]> {
  const run = (chains.get(id) ?? Promise.resolve()).then(async () => {
    const messages = await loadMessages(id);
    const result = change(messages);
    if (result === false) return messages;
    const next = result ?? messages;
    await saveMessages(id, next);
    return next;
  });
  const tail = run.catch(() => {});
  chains.set(id, tail);
  void tail.then(() => chains.get(id) === tail && chains.delete(id));
  return run;
}

/** Every contact id with a stored message bucket - needed to migrate all of
 * them when encryption is enabled/disabled. */
export async function listMessageContactIds(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys();
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}
