const DB_NAME = "umbrachat-nicknames";
const STORE_NAME = "nicknames";

// ponytail: unencrypted, like pushPrefsStore.ts - a nickname is purely
// cosmetic local metadata, never sent to the server or the other party, so
// there's nothing here worth vault-gating.

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

export async function loadNickname(contactId: string): Promise<string | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(contactId);
    request.onsuccess = () => resolve(request.result as string | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveNickname(contactId: string, nickname: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const trimmed = nickname.trim();
    if (trimmed) {
      tx.objectStore(STORE_NAME).put(trimmed, contactId);
    } else {
      tx.objectStore(STORE_NAME).delete(contactId);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllNicknames(): Promise<Map<string, string>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const keys = store.getAllKeys();
    const values = store.getAll();
    values.onsuccess = () => resolve(new Map((keys.result as string[]).map((k, i) => [k, values.result[i] as string])));
    values.onerror = () => reject(values.error);
  });
}
