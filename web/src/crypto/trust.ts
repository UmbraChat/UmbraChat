import type { SignalStore } from "wasm-crypto";
import type { LocalAccount } from "../storage/keyStore";
import { loadSession, saveSession } from "../storage/keyStore";
import type { ChainState } from "./deviceList";
import { verifiedChain } from "./chains";
import { restoreSession } from "./session";
import { computeSafetyNumber, computePairwiseSafetyNumber } from "./identity";

/**
 * Who may talk to us. A contact's devices are the ones in the account's signed device list
 * (crypto/chains.ts): a device in it is admitted without any manual step, one that is not, or
 * that shows a key other than the listed one, is refused. There is no "accept anyway": it would
 * be the very click-through the signed list exists to remove. Refusals are kept as notices the
 * user can read (they persist across reloads) and dismiss.
 */
export interface TrustAlert {
  id: string;
  reason: "unlisted-device" | "key-mismatch" | "key-changed" | "chain-withheld" | "chain-forked";
  contactId: string;
  deviceId?: string;
  /** Key fingerprint of the device the notice is about, as its own identity screen shows it. */
  fingerprint?: string;
}

// A server must not be able to make us store without bound by inventing devices.
const MAX_ALERTS = 20;

// Kept in the session store under a key that is no session address (no colon), so it is
// encrypted, migrated and backed up exactly like the sessions.
const STATE_KEY = "@trust";

const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const alerts = new Map<string, TrustAlert>();
const listeners = new Set<(a: TrustAlert[]) => void>();
let loaded: Promise<void> | undefined;

async function persist(): Promise<void> {
  await saveSession(STATE_KEY, new TextEncoder().encode(JSON.stringify({ alerts: [...alerts.values()] })));
}

function notify(): void {
  const list = [...alerts.values()];
  for (const listener of listeners) listener(list);
}

/** Loads the persisted notices once the local store is readable (after unlock). Idempotent. */
export function loadTrustState(): Promise<void> {
  loaded ??= (async () => {
    const bytes = await loadSession(STATE_KEY);
    if (!bytes) return;
    const state = JSON.parse(new TextDecoder().decode(bytes)) as { alerts?: TrustAlert[] };
    for (const alert of state.alerts ?? []) if (alert.reason) alerts.set(alert.id, alert);
    notify();
  })().catch((err) => {
    loaded = undefined; // locked or unreadable: try again next time
    throw err;
  });
  return loaded;
}

export function subscribeToTrustAlerts(listener: (a: TrustAlert[]) => void): () => void {
  listeners.add(listener);
  listener([...alerts.values()]);
  return () => listeners.delete(listener);
}

export async function dismissTrustAlert(id: string): Promise<void> {
  if (alerts.delete(id)) {
    notify();
    await persist();
  }
}

/** Records a refusal or a server inconsistency for the user to see. The same one is shown once. */
export async function raiseNotice(reason: TrustAlert["reason"], contactId: string, deviceId?: string, identity?: ArrayLike<number>): Promise<void> {
  await loadTrustState();
  const id = `${reason}:${contactId}:${deviceId ?? ""}`;
  if (alerts.has(id) || alerts.size >= MAX_ALERTS) return;
  alerts.set(id, { id, reason, contactId, deviceId, fingerprint: identity ? await computeSafetyNumber(Array.from(identity)) : undefined });
  notify();
  await persist();
}

const sameKey = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && hex(a) === hex(b);

/**
 * Whether session address `key` may use `identity`: the device must be in the contact's verified
 * list with exactly that key, and must not already be pinned to another one.
 */
export async function admitPeer(store: SignalStore, contactId: string, deviceId: string, key: string, identity: ArrayLike<number>, chain: ChainState): Promise<boolean> {
  const listed = chain.devices.find((d) => d.deviceId === deviceId);
  if (!listed) {
    await raiseNotice("unlisted-device", contactId, deviceId, identity);
    return false;
  }
  if (!sameKey(listed.identityKey, identity)) {
    await raiseNotice("key-mismatch", contactId, deviceId, identity);
    return false;
  }
  const pinned = store.peer_identity(key);
  if (pinned && !sameKey(pinned, identity)) {
    await raiseNotice("key-changed", contactId, deviceId, identity);
    return false;
  }
  return true;
}

export interface DeviceFingerprint {
  deviceId: string;
  label: string;
  /** Safety number of this conversation with that device: both sides must see the same one. */
  safetyNumber: string;
}

/** Safety numbers between this device and each of a contact's listed devices we hold a session with. */
export async function contactSafetyNumbers(contactId: string, account: LocalAccount, store: SignalStore): Promise<DeviceFingerprint[]> {
  const out: DeviceFingerprint[] = [];
  for (const device of (await verifiedChain(contactId, account)).devices) {
    const key = `${contactId}:${device.deviceId}`;
    await restoreSession(store, key);
    const identity = store.peer_identity(key);
    if (identity) out.push({ deviceId: device.deviceId, label: device.deviceId.slice(0, 8), safetyNumber: await computePairwiseSafetyNumber(account.identity.identity_public_key, identity) });
  }
  return out;
}
