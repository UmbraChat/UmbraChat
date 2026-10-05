import type { LocalAccount } from "../storage/keyStore";
import { loadSession, saveSession } from "../storage/keyStore";
import { fetchStatements } from "../api/chain";
import { verifyChain, type ChainState, type SignedStatement } from "./deviceList";
import { formatInvite, type Invite } from "./invite";

/**
 * What this device has verified of each account's signed device list (its own account included):
 * the pin every later statement is checked against. Stored encrypted in the session store under a
 * key that is no session address (no colon), so vault migration and backup carry it. First sight of
 * an account's chain is trusted on first use, like a first key; after that only valid continuations
 * are accepted, and a device that vouches for a chain cannot be swapped by the server.
 */
const STATE_KEY = "@chains";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));

interface StoredPin {
  accountId: string;
  version: number;
  head: string;
  devices: { deviceId: string; key: string }[];
}

const pins = new Map<string, ChainState>();
let loaded: Promise<void> | undefined;
const inflight = new Map<string, Promise<ChainState>>();
let saving: Promise<unknown> = Promise.resolve();

function load(): Promise<void> {
  loaded ??= (async () => {
    const bytes = await loadSession(STATE_KEY);
    if (!bytes) return;
    for (const p of JSON.parse(new TextDecoder().decode(bytes)) as StoredPin[]) {
      pins.set(p.accountId, { accountId: p.accountId, version: p.version, head: unhex(p.head), devices: p.devices.map((d) => ({ deviceId: d.deviceId, identityKey: unhex(d.key) })) });
    }
  })().catch((err) => {
    loaded = undefined; // locked or unreadable: try again next time
    throw err;
  });
  return loaded;
}

function save(): Promise<unknown> {
  const stored: StoredPin[] = [...pins.values()].map((p) => ({ accountId: p.accountId, version: p.version, head: hex(p.head), devices: p.devices.map((d) => ({ deviceId: d.deviceId, key: hex(d.identityKey) })) }));
  saving = saving.then(() => saveSession(STATE_KEY, new TextEncoder().encode(JSON.stringify(stored))));
  return saving;
}

/** The pin we hold for an account, without asking the server. */
export async function pinnedChain(accountId: string): Promise<ChainState | undefined> {
  await load();
  return pins.get(accountId);
}

/**
 * The account's device list, verified: fetches what is newer than our pin and checks every
 * statement. Throws when what the server sends is not a valid continuation (or, for the first
 * sight of our own account, does not list this device); a ChainUnavailableError when the server
 * could not be asked. `maxAgeMs` lets a caller reuse a recent answer instead of asking again.
 */
export function verifiedChain(accountId: string, account: LocalAccount, maxAgeMs = 0): Promise<ChainState> {
  const running = inflight.get(accountId);
  if (running) return running;
  const run = (async () => {
    await load();
    const pin = pins.get(accountId);
    if (pin && maxAgeMs > 0 && Date.now() - (checkedAt.get(accountId) ?? 0) < maxAgeMs) return pin;
    const statements = await fetchStatements(accountId, pin?.version ?? 0, account);
    const state = await verifyChain(statements, pin);
    if (state.accountId !== accountId) throw new Error("the server answered with another account's device list");
    if (accountId === account.accountId && !pin && !state.devices.some((d) => d.identityKey.length === account.identity.identity_public_key.length && d.identityKey.every((b, i) => b === account.identity.identity_public_key[i]))) {
      throw new Error("your account's device list does not include this device's key");
    }
    checkedAt.set(accountId, Date.now());
    if (!pin || state.version !== pin.version) {
      pins.set(accountId, state);
      await save();
    }
    return state;
  })().finally(() => inflight.delete(accountId));
  inflight.set(accountId, run);
  return run;
}

const checkedAt = new Map<string, number>();

/** Verifies a whole chain statement by statement and returns the final state with the head after each version. */
async function verifyWithHeads(statements: SignedStatement[]): Promise<{ state: ChainState; heads: Map<number, string> }> {
  let state: ChainState | undefined;
  const heads = new Map<number, string>();
  for (const s of statements) {
    state = await verifyChain([s], state);
    heads.set(state.version, hex(state.head));
  }
  if (!state) throw new Error("the server has no device list for this account");
  return { state, heads };
}

/** This account's invite: its id and the head of its first statement (see crypto/invite.ts). */
export async function inviteFor(account: LocalAccount): Promise<string> {
  const { heads } = await verifyWithHeads(await fetchStatements(account.accountId, 0, account));
  return formatInvite(account.accountId, heads.get(1)!);
}

/**
 * Pins `accountId`'s chain after checking it descends from the first list the invite names. Refuses
 * when the server shows another chain (a wrong invite, or a lying server), or one that does not
 * continue what we pinned before (an earlier trust-on-first-use that turns out to have been wrong).
 */
export async function acceptInvite(invite: Invite, account: LocalAccount): Promise<void> {
  await load();
  const { state, heads } = await verifyWithHeads(await fetchStatements(invite.accountId, 0, account));
  if (state.accountId !== invite.accountId || heads.get(1) !== invite.genesis) {
    throw new Error("this invite does not match the device list the server shows for that account: a wrong invite, or the server is lying");
  }
  const pin = pins.get(invite.accountId);
  if (pin && heads.get(pin.version) !== hex(pin.head)) {
    throw new Error("the server shows a device list that does not continue the one you saw before for this account");
  }
  pins.set(invite.accountId, state);
  checkedAt.delete(invite.accountId);
  await save();
}

/** Called after this device published a statement itself, so the next read starts from it. */
export async function adoptChain(state: ChainState): Promise<void> {
  await load();
  pins.set(state.accountId, state);
  checkedAt.delete(state.accountId);
  await save();
}

export const headHex = hex;
