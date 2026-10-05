import type { SignalStore } from "wasm-crypto";
import type { LocalAccount } from "../storage/keyStore";
import { prekey_message_identity } from "wasm-crypto";
import { openStore, persistSession, restoreSession } from "../crypto/session";
import { admitPeer, raiseNotice } from "../crypto/trust";
import { headHex, pinnedChain, verifiedChain } from "../crypto/chains";
import { ChainUnavailableError } from "../api/chain";
import { holdForRetry, takeRetries } from "./retryQueue";
import { fetchPrekeyBundle } from "../api/prekeyBundle";
import { sendMessage, fetchMessages, type ReceivedMessage } from "../api/messages";
import { toBase64, fromBase64 } from "../api/codec";
import { loadMessages, updateMessages, type ChatMessage } from "../storage/messageStore";

interface TextEnvelope {
  type: "text";
  id: string;
  body: string;
}

interface FileEnvelope {
  type: "file";
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  // base64, not a JSON array of numbers - a plain number[] blows up to ~3.5x
  // the raw size once JSON-stringified (each byte becomes 1-3 ASCII digits
  // plus a comma), on top of the outer request's own base64 layer. That
  // compounded a file well under MAX_FILE_BYTES into a wire payload that
  // could exceed the server's body limit, with the client stuck waiting on
  // an upload that could never finish - this is what "stuck in sending"
  // actually was. base64 keeps the expansion to the ~1.33x the size budget
  // (MAX_FILE_BYTES vs the server's MAX_BODY_BYTES) always assumed.
  data: string;
  destructOnOpen?: boolean;
  timerSeconds?: number;
}

interface ReceiptEnvelope {
  type: "delivered" | "read";
  refId: string;
}

interface FileOpenedEnvelope {
  type: "file-opened";
  refId: string;
}

interface TimerEnvelope {
  type: "timer";
  seconds: number;
}

interface TypingEnvelope {
  type: "typing";
}

export interface CallOfferEnvelope {
  type: "call-offer";
  callId: string;
  kind: "voice" | "video";
  sdp: string;
}

export interface CallAnswerEnvelope {
  type: "call-answer";
  callId: string;
  sdp: string;
}

export interface CallIceEnvelope {
  type: "call-ice";
  callId: string;
  candidate: RTCIceCandidateInit;
}

export interface CallEndEnvelope {
  type: "call-end";
  callId: string;
  reason: "hangup" | "declined" | "cancelled" | "timeout" | "failed";
}

export type CallEnvelope = CallOfferEnvelope | CallAnswerEnvelope | CallIceEnvelope | CallEndEnvelope;

function isCallEnvelope(envelope: Envelope): envelope is CallEnvelope {
  return envelope.type === "call-offer" || envelope.type === "call-answer" || envelope.type === "call-ice" || envelope.type === "call-end";
}

export interface GroupInviteEnvelope {
  type: "group-invite";
  groupId: string;
  name: string;
  memberAccountIds: string[];
}

export interface GroupUpdateEnvelope {
  type: "group-update";
  groupId: string;
  memberAccountIds: string[];
}

export interface GroupTextEnvelope {
  type: "group-text";
  groupId: string;
  id: string;
  body: string;
}

export type GroupEnvelope = GroupInviteEnvelope | GroupUpdateEnvelope | GroupTextEnvelope;

export function isGroupEnvelope(envelope: Envelope): envelope is GroupEnvelope {
  return envelope.type === "group-invite" || envelope.type === "group-update" || envelope.type === "group-text";
}

/**
 * Every envelope carries (version, head) of the sender's own device list as the sender last
 * verified it. A receiver whose server shows an older list for that sender knows the server is
 * holding something back (a removal, say), and one shown a different head at the same version
 * knows it is being shown another list than the sender's.
 */
interface ChainStamp {
  v: number;
  h: string;
}
type Stamped = Envelope & { chain: ChainStamp };

type Envelope = TextEnvelope | FileEnvelope | ReceiptEnvelope | FileOpenedEnvelope | TimerEnvelope | TypingEnvelope | CallEnvelope | GroupEnvelope;

const MAX_TIMER_SECONDS = 366 * 24 * 3600;
const isString = (v: unknown): v is string => typeof v === "string";
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TIMER_SECONDS;
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1000 && v.every(isString);

/**
 * Shape check on a decrypted envelope. The sender is another account, not necessarily a
 * friend: a wrong type or an absurd number must be dropped here, not crash a later step
 * (new Date(Infinity).toISOString() throws) or store garbage in the history.
 */
function isValidEnvelope(value: unknown): value is Stamped {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  const stamp = e.chain as Record<string, unknown> | null | undefined;
  if (typeof stamp !== "object" || stamp === null || !Number.isInteger(stamp.v) || (stamp.v as number) < 1 || !isString(stamp.h) || !/^[0-9a-f]{64}$/.test(stamp.h)) return false;
  switch (e.type) {
    case "text":
      return isString(e.id) && isString(e.body);
    case "file":
      return (
        isString(e.id) && isString(e.filename) && isString(e.mimeType) && isString(e.data) &&
        typeof e.size === "number" && Number.isFinite(e.size) && (e.timerSeconds === undefined || isSeconds(e.timerSeconds))
      );
    case "delivered":
    case "read":
    case "file-opened":
      return isString(e.refId);
    case "timer":
      return isSeconds(e.seconds);
    case "typing":
      return true;
    case "call-offer":
      return isString(e.callId) && isString(e.sdp) && (e.kind === "voice" || e.kind === "video");
    case "call-answer":
      return isString(e.callId) && isString(e.sdp);
    case "call-ice":
      return isString(e.callId) && typeof e.candidate === "object" && e.candidate !== null;
    case "call-end":
      return isString(e.callId) && isString(e.reason);
    case "group-invite":
      return isString(e.groupId) && isString(e.name) && isIds(e.memberAccountIds);
    case "group-update":
      return isString(e.groupId) && isIds(e.memberAccountIds);
    case "group-text":
      return isString(e.groupId) && isString(e.id) && isString(e.body);
    default:
      return false;
  }
}

/** The composite session address a contact's specific device is addressed by.
 * `wasm-crypto` treats this as an opaque string name (its own device_id field
 * stays hardcoded at 1) - two different devices are just two different names,
 * no Rust/WASM changes needed for multi-device. See the plan's Decisions. */
function sessionKey(contactAccountId: string, deviceId: string): string {
  return `${contactAccountId}:${deviceId}`;
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

/** Adds the sender's device-list stamp to an envelope about to be encrypted. */
async function stamped(plaintext: Uint8Array, account: LocalAccount): Promise<Uint8Array> {
  const own = await verifiedChain(account.accountId, account, OWN_CHAIN_MAX_AGE_MS);
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return plaintext; // not an envelope at all: sent as is (only tests send such bytes, to see how a receiver copes)
  }
  envelope.chain = { v: own.version, h: headHex(own.head) } satisfies ChainStamp;
  return new TextEncoder().encode(JSON.stringify(envelope));
}

// How old our view of our own list may be when stamping: seconds, not minutes, so a removal
// done from another device is in the next message, without a request per message.
const OWN_CHAIN_MAX_AGE_MS = 15000;

/**
 * Fans an envelope out to every device in `contactId`'s signed device list, establishing a
 * session with any device that has none yet. Every send site in this module routes through here.
 * The list is the one verified against our pin (crypto/chains.ts), not the server's say-so: a
 * device the server invents is not in it, and a device whose prekey bundle shows another key
 * than the listed one is skipped.
 */
export function sendToContact(contactId: string, plaintext: Uint8Array, account: LocalAccount, store: SignalStore): Promise<void> {
  // One send at a time per contact: a burst (a call's ICE candidates) would otherwise find "no
  // session yet" all at once and each set up its own, scrambling the ratchet on both sides.
  const run = (sendTails.get(contactId) ?? Promise.resolve()).then(() => deliver(contactId, plaintext, account, store));
  const tail = run.catch(() => undefined);
  sendTails.set(contactId, tail);
  void tail.then(() => sendTails.get(contactId) === tail && sendTails.delete(contactId));
  return run;
}

const sendTails = new Map<string, Promise<unknown>>();

async function deliver(contactId: string, plaintext: Uint8Array, account: LocalAccount, store: SignalStore): Promise<void> {
  let chain;
  try {
    chain = await verifiedChain(contactId, account);
  } catch (err) {
    if (err instanceof ChainUnavailableError) throw err;
    throw new Error(`this contact has no usable signed device list: ${err instanceof Error ? err.message : err}`);
  }
  const body = await stamped(plaintext, account);
  let reached = 0;
  for (const device of chain.devices) {
    const key = sessionKey(contactId, device.deviceId);
    await restoreSession(store, key);
    if (!store.has_session(key)) {
      const bundle = await fetchPrekeyBundle(device.deviceId, account);
      if (!sameBytes(bundle.identity_public_key, device.identityKey)) {
        await raiseNotice("key-mismatch", contactId, device.deviceId, bundle.identity_public_key);
        continue;
      }
      store.establish_session(key, bundle);
    } else {
      const pinned = store.peer_identity(key);
      if (pinned && !sameBytes(pinned, device.identityKey)) {
        await raiseNotice("key-changed", contactId, device.deviceId, pinned);
        continue;
      }
    }
    const ciphertext = store.encrypt(key, body);
    await sendMessage(device.deviceId, ciphertext, account);
    await persistSession(store, key);
    reached++;
  }
  // Every device being refused must not look like a successful send.
  if (reached === 0) throw new Error("not sent: no device of this contact matches their signed device list, see the security alerts");
}

/** Sends a call-signaling envelope through the same encrypted pipe as everything else - never shown as a chat message. */
export async function sendCallSignal(contactId: string, envelope: CallEnvelope, account: LocalAccount, store: SignalStore): Promise<void> {
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(envelope)), account, store);
}

/**
 * Sends a "typing" ping through the same encrypted pipe as everything else -
 * never persisted, never shown as a chat message. Callers (the composer, see
 * screens/Conversation.tsx) are responsible for debouncing and for only
 * calling this while the typing-indicator preference is on.
 */
export async function sendTypingSignal(contactId: string, account: LocalAccount, store: SignalStore): Promise<void> {
  const envelope: TypingEnvelope = { type: "typing" };
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(envelope)), account, store);
}

// A polled transport has no delivery guarantee for an explicit "stopped
// typing" signal, so "is typing" is instead a rolling window: each incoming
// ping resets the timer, and silence for this long clears it back to false.
const TYPING_IDLE_MS = 5000;

let typingActive = false;
let typingIdleTimer: number | undefined;
const typingListeners = new Set<(active: boolean) => void>();

function setTypingActive(active: boolean): void {
  typingActive = active;
  for (const listener of typingListeners) listener(typingActive);
}

export function getTypingActive(): boolean {
  return typingActive;
}

/** Subscribes to the open contact's typing state; returns an unsubscribe function. */
export function subscribeToTypingState(listener: (active: boolean) => void): () => void {
  typingListeners.add(listener);
  return () => typingListeners.delete(listener);
}

// Only ever called from poll()'s already-open-contact branch (see poll's own
// doc comment) - a typing signal from anyone else is dropped there and never
// reaches this function, so there's no per-sender bookkeeping to do here.
function handleTypingSignal(): void {
  window.clearTimeout(typingIdleTimer);
  setTypingActive(true);
  typingIdleTimer = window.setTimeout(() => setTypingActive(false), TYPING_IDLE_MS);
}

/** Clears typing state immediately - call when leaving a conversation so a
 * stale "is typing" doesn't bleed into whichever contact is opened next. */
export function resetTypingState(): void {
  window.clearTimeout(typingIdleTimer);
  setTypingActive(false);
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function isFileTooLarge(file: File): boolean {
  return file.size > MAX_FILE_BYTES;
}

/**
 * Re-encodes any image that isn't already JPEG/WebP into WebP before it's
 * sent - fixes two things at once: phone camera formats like HEIC render as
 * a plain download link everywhere except Safari (no <img> support), and
 * they're frequently bigger than MAX_FILE_BYTES, so shrinking here also
 * means fewer "too large" rejections. Canvas + createImageBitmap are native,
 * evergreen-browser APIs - no image library needed for a single re-encode.
 */
async function normalizeImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/jpeg" || file.type === "image/webp") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
  } catch {
    // Some inputs createImageBitmap can't decode at all - send the original
    // rather than blocking the send outright.
    return file;
  }
}

function timerKey(contactId: string): string {
  return `umbrachat:timer:${contactId}`;
}

/** 0 means off - matches the default when nothing has been set yet. */
export function getTimerSeconds(contactId: string): number {
  return Number(localStorage.getItem(timerKey(contactId)) ?? 0);
}

function setTimerSecondsLocal(contactId: string, seconds: number): void {
  localStorage.setItem(timerKey(contactId), String(seconds));
}

export async function setDisappearingTimer(contactId: string, seconds: number, account: LocalAccount, store: SignalStore): Promise<void> {
  const envelope: TimerEnvelope = { type: "timer", seconds };
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(envelope)), account, store);
  setTimerSecondsLocal(contactId, seconds);
}

/** Opens the local store. Sessions are established lazily per device inside
 * `sendToContact`/`poll`, so there's nothing left for this to do eagerly. */
export async function startConversation(_contactId: string, account: LocalAccount): Promise<SignalStore> {
  return openStore(account.identity);
}

export async function sendText(contactId: string, text: string, account: LocalAccount, store: SignalStore): Promise<ChatMessage[]> {
  const envelope: TextEnvelope = { type: "text", id: crypto.randomUUID(), body: text };
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(envelope)), account, store);

  const timerSeconds = getTimerSeconds(contactId);
  return updateMessages(contactId, (messages) => {
    messages.push({
      id: envelope.id,
      direction: "sent",
      text,
      status: "sent",
      createdAt: new Date().toISOString(),
      ...(timerSeconds > 0 ? { timerSeconds } : {}),
    });
  });
}

export type FileSendStage = "encrypting" | "sending" | "sent";
export type FileDestruct = { onOpen: true } | { afterSeconds: number };

export async function sendFile(
  contactId: string,
  file: File,
  account: LocalAccount,
  store: SignalStore,
  onStage: (stage: FileSendStage) => void,
  destruct?: FileDestruct,
): Promise<ChatMessage[]> {
  onStage("encrypting");
  const normalized = await normalizeImage(file);
  if (isFileTooLarge(normalized)) throw new Error(`${normalized.name} is too large (max 8MB) even after compression`);
  const bytes = new Uint8Array(await normalized.arrayBuffer());
  const envelope: FileEnvelope = {
    type: "file",
    id: crypto.randomUUID(),
    filename: normalized.name,
    mimeType: normalized.type || "application/octet-stream",
    size: normalized.size,
    data: toBase64(bytes),
    ...(destruct && "onOpen" in destruct ? { destructOnOpen: true } : {}),
    ...(destruct && "afterSeconds" in destruct ? { timerSeconds: destruct.afterSeconds } : {}),
  };

  onStage("sending");
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(envelope)), account, store);

  const messages = await updateMessages(contactId, (history) => {
    history.push({
      id: envelope.id,
      direction: "sent",
      text: "",
      status: "sent",
      createdAt: new Date().toISOString(),
      file: { filename: envelope.filename, mimeType: envelope.mimeType, size: envelope.size, bytes },
      ...(destruct && "onOpen" in destruct ? { destructOnOpen: true } : {}),
      // Pegged to send time, not read time: a timed file must vanish on schedule
      // even if the recipient never opens it, unlike disappearing text messages.
      ...(destruct && "afterSeconds" in destruct ? { expiresAt: new Date(Date.now() + destruct.afterSeconds * 1000).toISOString() } : {}),
    });
  });
  onStage("sent");
  return messages;
}

/**
 * Reports back that a received file was opened - always, for the sender's
 * visibility, regardless of destruct mode - and, if it was on-open, deletes it
 * from local storage immediately rather than waiting for the next poll's sweep.
 */
export async function markFileOpened(contactId: string, messageId: string, account: LocalAccount, store: SignalStore): Promise<ChatMessage[]> {
  const receipt: FileOpenedEnvelope = { type: "file-opened", refId: messageId };
  await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(receipt)), account, store);

  return updateMessages(contactId, (messages) => {
    if (!messages.find((m) => m.id === messageId)?.destructOnOpen) return false;
    return messages.filter((m) => m.id !== messageId);
  });
}

/**
 * Sends "read" receipts for received messages in `contactId`'s local history
 * that only have a "delivered" one so far - call this when the user actually
 * opens that conversation, not the moment a message is buffered while it's
 * still closed. Security fix: a message from a sender other than the open
 * contact used to get both delivered *and* read sent back the instant the
 * background poll decrypted it, regardless of whether anyone had looked at
 * anything - that turned "read" into a presence oracle (a sender who only
 * knows the target's account id could probe for exactly when their device is
 * unlocked/foregrounded, with no accept step and no way to suppress it).
 * "Delivered" alone is left automatic; it only confirms a client is polling
 * at all, a much coarser signal already close to what device listing already
 * exposes - "read" now means a person actually opened the conversation.
 */
export async function markConversationRead(contactId: string, account: LocalAccount, store: SignalStore): Promise<ChatMessage[]> {
  const unread = (await loadMessages(contactId)).filter((m) => m.direction === "received" && m.status === "delivered");
  for (const m of unread) {
    const receipt: ReceiptEnvelope = { type: "read", refId: m.id };
    await sendToContact(contactId, new TextEncoder().encode(JSON.stringify(receipt)), account, store);
  }
  const sent = new Set(unread.map((m) => m.id));
  return updateMessages(contactId, (messages) => {
    let changed = false;
    for (const m of messages) {
      if (!sent.has(m.id) || m.status !== "delivered") continue;
      m.status = "read";
      changed = true;
    }
    return changed ? undefined : false;
  });
}

function buildReceivedTextMessage(envelope: TextEnvelope, createdAt: string, timerSeconds: number): ChatMessage {
  return {
    id: envelope.id,
    direction: "received",
    text: envelope.body,
    status: "delivered",
    createdAt,
    // Decrypting is already this app's "read" moment (see the receipt loop
    // wherever this is called from), so the expiry clock starts now.
    ...(timerSeconds > 0 ? { expiresAt: new Date(Date.now() + timerSeconds * 1000).toISOString() } : {}),
  };
}

function buildReceivedFileMessage(envelope: FileEnvelope, createdAt: string): ChatMessage {
  return {
    id: envelope.id,
    direction: "received",
    text: "",
    status: "delivered",
    createdAt,
    file: { filename: envelope.filename, mimeType: envelope.mimeType, size: envelope.size, bytes: fromBase64(envelope.data) },
    ...(envelope.destructOnOpen ? { destructOnOpen: true } : {}),
    ...(envelope.timerSeconds ? { expiresAt: new Date(Date.now() + envelope.timerSeconds * 1000).toISOString() } : {}),
  };
}

/**
 * Fetches and decrypts any pending messages, updates local history, and
 * replies with receipts. A text/file message from a sender other than the
 * currently open contact - including a first-ever message from someone new -
 * is still saved into that sender's own local history and reported via
 * `onIncomingChat`, rather than dropped: `GET /v1/messages` is fetch-and-
 * delete server-side, so this is the only chance to keep it. Call signals are
 * forwarded to `onCallSignal` from any sender, open or not. Timers and
 * receipts only make sense inside an already-open conversation with that
 * sender and are dropped if it's not open.
 *
 * Receipts: for the currently open contact, delivered and read fire together
 * as soon as a text message is decrypted, since the user is actively looking
 * at that conversation right now. For anyone else, only "delivered" fires
 * here - "read" is deferred to `markConversationRead`, called once the user
 * actually opens that conversation (see its doc comment for why: sending
 * "read" automatically for an unopened sender was a presence oracle). Files
 * don't get delivered/read receipts at all yet - only text does; add them if
 * file status tracking turns out to matter.
 */
// GET /v1/messages is fetch-and-delete and every poll reads, extends and rewrites the local
// history of whoever wrote: two polls running at once (an interval firing while the previous
// one is still busy, a forced poll on becoming visible) lose messages that way. They queue.
let pollTail: Promise<unknown> = Promise.resolve();

export function poll(...args: Parameters<typeof pollOnce>): ReturnType<typeof pollOnce> {
  const run = pollTail.then(() => pollOnce(...args));
  pollTail = run.catch(() => undefined);
  return run;
}

/**
 * Compares the device-list stamp an envelope carries with what the server shows us for its
 * sender. Never throws: the message is already decrypted, and nothing here may make it look lost.
 * A stamp newer than anything the server will give us, or a different head at the same version,
 * is raised to the user.
 */
async function checkStamp(senderId: string, stamp: ChainStamp, account: LocalAccount): Promise<void> {
  try {
    let state = await pinnedChain(senderId);
    if (!state || stamp.v > state.version) {
      try {
        state = await verifiedChain(senderId, account);
      } catch (err) {
        if (!(err instanceof ChainUnavailableError)) return raiseNotice("chain-forked", senderId);
      }
    }
    if (!state || stamp.v > state.version) return raiseNotice("chain-withheld", senderId);
    if (stamp.v === state.version && headHex(state.head) !== stamp.h) return raiseNotice("chain-forked", senderId);
  } catch (err) {
    console.warn("could not check a device-list stamp:", err);
  }
}

async function pollOnce(
  contactId: string | undefined,
  account: LocalAccount,
  store: SignalStore,
  onCallSignal?: (envelope: CallEnvelope, senderAccountId: string) => Promise<void>,
  onGroupSignal?: (envelope: GroupEnvelope, senderAccountId: string) => Promise<void>,
  onIncomingChat?: (senderAccountId: string) => void,
): Promise<ChatMessage[]> {
  // Messages that could not be processed last time only because the server was unreachable go first.
  const received = [...(await takeRetries()), ...(await fetchMessages(account))];
  // Every history change goes through updateMessages, one envelope at a time, so a send
  // running in parallel can never overwrite it (or be overwritten by it).
  const append = (id: string, message: ChatMessage) => updateMessages(id, (history) => void history.push(message));
  const markSent = (id: string, refId: string, change: (m: ChatMessage) => void) =>
    updateMessages(id, (history) => {
      const target = history.find((m) => m.id === refId && m.direction === "sent");
      if (!target) return false;
      change(target);
    });

  // Messages whose ratchet step is done: one of these must never be retried (it would not decrypt twice).
  const consumed = new WeakSet<ReceivedMessage>();

  // Receipts are best effort. The message they answer is already stored, and a failure here
  // (server unreachable) must not make the message look unprocessed.
  const sendReceipt = (to: string, receipt: ReceiptEnvelope) =>
    sendToContact(to, new TextEncoder().encode(JSON.stringify(receipt)), account, store).catch((err) => console.warn("receipt not sent:", err));

  async function handle(message: ReceivedMessage): Promise<void> {
    // Every message is decrypted regardless of sender, *before* deciding
    // whether it's for the open 1:1 conversation - a group message can arrive
    // from any member, not just whichever contact happens to be open, so the
    // old sender-must-match filter would silently drop it if checked first.
    // Side effect, not the point: this also fixes a latent bug where a message
    // from a non-open sender was never decrypted at all, permanently desyncing
    // that sender's local ratchet from the one they hold.
    const key = sessionKey(message.senderAccountId, message.senderDeviceId);
    await restoreSession(store, key);
    // A first message carries the sender's identity key: it is admitted only if that device, with
    // that key, is in the sender's signed device list. Our pin is asked first; the server only when
    // the pin does not know the device yet (a device added since we last looked).
    const firstMessageIdentity = prekey_message_identity(message.envelope);
    if (firstMessageIdentity) {
      let chain = await pinnedChain(message.senderAccountId);
      if (!chain?.devices.some((d) => d.deviceId === message.senderDeviceId && sameBytes(d.identityKey, firstMessageIdentity))) {
        try {
          chain = await verifiedChain(message.senderAccountId, account);
        } catch (err) {
          if (err instanceof ChainUnavailableError) throw err;
          await raiseNotice("chain-forked", message.senderAccountId);
          return;
        }
      }
      if (!(await admitPeer(store, message.senderAccountId, message.senderDeviceId, key, firstMessageIdentity, chain))) return;
    }
    const plaintext = store.decrypt(key, message.envelope);
    consumed.add(message);
    const envelope: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (!isValidEnvelope(envelope)) {
      console.warn(`dropped a malformed envelope from ${message.senderAccountId}`);
      await persistSession(store, key);
      return;
    }
    await checkStamp(message.senderAccountId, envelope.chain, account);

    if (isGroupEnvelope(envelope)) {
      await onGroupSignal?.(envelope, message.senderAccountId);
      await persistSession(store, key);
      return;
    }

    if (isCallEnvelope(envelope)) {
      await onCallSignal?.(envelope, message.senderAccountId);
      await persistSession(store, key);
      return;
    }

    if (!contactId || message.senderAccountId !== contactId) {
      if (envelope.type === "text") {
        await append(message.senderAccountId, buildReceivedTextMessage(envelope, message.createdAt, getTimerSeconds(message.senderAccountId)));
        // "delivered" only, not "read" - see markConversationRead's doc comment.
        await sendReceipt(message.senderAccountId, { type: "delivered", refId: envelope.id });
        onIncomingChat?.(message.senderAccountId);
      } else if (envelope.type === "file") {
        await append(message.senderAccountId, buildReceivedFileMessage(envelope, message.createdAt));
        onIncomingChat?.(message.senderAccountId);
      } else {
        // Timer/file-opened/receipts only make sense inside an already-
        // open conversation with that sender - nothing to update if it's not.
        console.warn(`dropped a ${envelope.type} envelope from ${message.senderAccountId}: no open conversation for that sender`);
      }
      await persistSession(store, key);
      return;
    }

    if (envelope.type === "text") {
      await append(contactId, buildReceivedTextMessage(envelope, message.createdAt, getTimerSeconds(contactId)));

      for (const type of ["delivered", "read"] as const) {
        await sendReceipt(contactId, { type, refId: envelope.id });
      }
    } else if (envelope.type === "file") {
      await append(contactId, buildReceivedFileMessage(envelope, message.createdAt));
    } else if (envelope.type === "timer") {
      setTimerSecondsLocal(contactId, envelope.seconds);
    } else if (envelope.type === "file-opened") {
      await markSent(contactId, envelope.refId, (m) => void (m.status = "opened"));
    } else if (envelope.type === "typing") {
      handleTypingSignal();
    } else {
      const status = envelope.type;
      await markSent(contactId, envelope.refId, (target) => {
        target.status = status;
        if (status === "read" && target.timerSeconds && !target.expiresAt) {
          target.expiresAt = new Date(Date.now() + target.timerSeconds * 1000).toISOString();
        }
      });
    }

    await persistSession(store, key);
  }

  // One bad message (garbage ciphertext, replay, hostile fields) must not take the rest of the
  // batch with it: the server already deleted them, so a throw here loses them for good.
  for (const message of received) {
    try {
      await handle(message);
    } catch (err) {
      if (err instanceof ChainUnavailableError && !consumed.has(message)) {
        console.warn(`could not check ${message.senderAccountId}'s device list, will retry:`, err.message);
        await holdForRetry(message);
        continue;
      }
      console.warn(`dropped a message from ${message.senderAccountId}:`, err);
      // Decrypt may have advanced the ratchet before the failure: keep disk and memory in step.
      await persistSession(store, sessionKey(message.senderAccountId, message.senderDeviceId)).catch(() => {});
    }
  }

  if (!contactId) return [];
  // Sweeps expired messages, and returns the open history for the screen.
  return updateMessages(contactId, (history) => {
    const now = Date.now();
    const alive = history.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now);
    return alive.length === history.length ? false : alive;
  });
}
