import init, { SignalStore } from "wasm-crypto";
import type { IdentityBundle } from "./identity";
import { loadSession, saveSession } from "../storage/keyStore";

let initialized: Promise<unknown> | undefined;

async function ensureInit(): Promise<void> {
  initialized ??= init();
  await initialized;
}

export interface ContactBundle {
  identity_public_key: number[];
  registration_id: number;
  signed_prekey: { key_id: number; public_key: number[]; signature: number[] };
  kyber_signed_prekey: { key_id: number; public_key: number[]; signature: number[] };
  one_time_prekey?: { key_id: number; public_key: number[] };
}

let openStores: { identityKey: string; store: Promise<SignalStore> } | undefined;

/** The store for the local identity. Sessions are restored lazily per device key via
 * `restoreSession`, not eagerly here - which devices exist for a contact isn't known until
 * their device list is fetched. One instance is shared by every screen and call: each holds
 * its own in-memory ratchet state, so two of them working on the same session would hand out
 * the same message counters. */
export function openStore(identity: IdentityBundle): Promise<SignalStore> {
  const identityKey = identity.identity_public_key.join(",");
  if (openStores?.identityKey !== identityKey) {
    const store = ensureInit().then(() => new SignalStore(identity));
    openStores = { identityKey, store };
    // A failed construction must not be cached.
    store.catch(() => {
      if (openStores?.store === store) openStores = undefined;
    });
  }
  return openStores.store;
}

// Writes for one session are applied in order, each exporting the state at the moment it
// runs: two overlapping saves could otherwise finish out of order and leave an older ratchet
// state on disk, which after a reload would reuse message counters.
const saving = new Map<string, Promise<void>>();

/** Persists `key`'s current session state - call after establish_session/encrypt/decrypt. */
export function persistSession(store: SignalStore, key: string): Promise<void> {
  const next = (saving.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const bytes = store.export_session(key);
    if (bytes) await saveSession(key, bytes);
  });
  saving.set(key, next);
  return next;
}

// One load per store and session at a time: two callers that both found the session missing
// would each import the stored state, and the second import would overwrite whatever the first
// caller had already done with it (two messages encrypted with the same counter).
const loading = new WeakMap<SignalStore, Map<string, Promise<void>>>();

/** Restores a previously persisted session for `key` into the store, if one exists and isn't already loaded. */
export async function restoreSession(store: SignalStore, key: string): Promise<void> {
  if (store.has_session(key)) return;
  let byKey = loading.get(store);
  if (!byKey) loading.set(store, (byKey = new Map()));
  let load = byKey.get(key);
  if (!load) {
    const pending = byKey;
    load = (async () => {
      const session = await loadSession(key);
      if (session && !store.has_session(key)) store.import_session(key, session);
    })().finally(() => pending.delete(key));
    byKey.set(key, load);
  }
  await load;
}
