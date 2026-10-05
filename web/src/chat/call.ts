import type { SignalStore } from "wasm-crypto";
import type { LocalAccount } from "../storage/keyStore";
import { fetchTurnServer } from "../api/turn";
import { sendCallSignal, type CallEnvelope, type CallEndEnvelope } from "./conversation";

export type CallKind = "voice" | "video";
export type CallEndReason = CallEndEnvelope["reason"];

export type CallState =
  | { status: "idle" }
  | { status: "outgoing-ringing"; callId: string; kind: CallKind; localStream: MediaStream; contactId: string }
  | { status: "incoming-ringing"; callId: string; kind: CallKind; callerAccountId: string }
  | { status: "connecting"; callId: string; kind: CallKind; localStream: MediaStream; remoteStream: MediaStream | null; contactId: string }
  | { status: "connected"; callId: string; kind: CallKind; localStream: MediaStream; remoteStream: MediaStream | null; contactId: string }
  | { status: "ended"; reason: CallEndReason; contactId?: string };

// TURN credentials come from the server per call (short-lived), never from VITE_*
// env vars: anything in the bundle is public, so a static credential would be an open relay.
// No third-party STUN by default: it would tell that provider who is calling. The operator's
// relay (TURN_URLS may include a stun: entry) or an explicit VITE_STUN_URL provides it.
function getIceServers(turn: RTCIceServer | null): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  if (import.meta.env.VITE_STUN_URL) servers.push({ urls: import.meta.env.VITE_STUN_URL });
  if (turn) servers.push(turn);
  return servers;
}

const ANSWER_TIMEOUT_MS = 30000;
const IDLE_RESET_MS = 3000;

let state: CallState = { status: "idle" };
let pc: RTCPeerConnection | null = null;
let pendingOffer: { callId: string; kind: CallKind; sdp: string; callerAccountId: string } | null = null;
let pendingIceCandidates: RTCIceCandidateInit[] = [];
// ontrack can fire before the "connecting" state exists yet (its timing relative
// to setRemoteDescription's own completion isn't guaranteed) - buffered here,
// independent of CallState, so an early track is never silently dropped.
let remoteStreamBuffer: MediaStream | null = null;
let answerTimer: number | undefined;
let idleResetTimer: number | undefined;
const listeners = new Set<(s: CallState) => void>();

function setState(next: CallState): void {
  // A pending "ended -> idle" reset must not outlive the "ended" state it belongs to: it would
  // otherwise wipe a call that starts (or rings) in the meantime, e.g. an offer polled in just
  // after the previous call ended.
  if (next.status !== "ended") window.clearTimeout(idleResetTimer);
  state = next;
  for (const listener of listeners) listener(state);
}

export function getCallState(): CallState {
  return state;
}

export function subscribeToCallState(listener: (s: CallState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cleanup(): void {
  window.clearTimeout(answerTimer);
  answerTimer = undefined;
  pc?.close();
  pc = null;
  pendingOffer = null;
  pendingIceCandidates = [];
  remoteStreamBuffer = null;
  // Releasing the camera/mic is not optional - leaving it on after a call ends
  // is a real privacy bug in an app built specifically to resist surveillance.
  if ("localStream" in state) for (const track of state.localStream.getTracks()) track.stop();
}

function scheduleIdleReset(): void {
  window.clearTimeout(idleResetTimer);
  idleResetTimer = window.setTimeout(() => setState({ status: "idle" }), IDLE_RESET_MS);
}

async function endCall(contactId: string, reason: CallEndReason, callId: string, account: LocalAccount, store: SignalStore): Promise<void> {
  cleanup();
  setState({ status: "ended", reason, contactId });
  scheduleIdleReset();
  await sendCallSignal(contactId, { type: "call-end", callId, reason }, account, store);
}

function newPeerConnection(contactId: string, callId: string, kind: CallKind, account: LocalAccount, store: SignalStore, turn: RTCIceServer | null): RTCPeerConnection {
  const conn = new RTCPeerConnection({ iceServers: getIceServers(turn) });

  conn.onicecandidate = (e) => {
    if (pc !== conn) return; // stale connection, already replaced/closed
    if (e.candidate) void sendCallSignal(contactId, { type: "call-ice", callId, candidate: e.candidate.toJSON() }, account, store);
  };

  conn.ontrack = (e) => {
    if (pc !== conn) return;
    remoteStreamBuffer = e.streams[0] ?? null;
    if (state.status === "connecting" || state.status === "connected") {
      setState({ ...state, remoteStream: remoteStreamBuffer });
    }
  };

  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    if (conn.connectionState === "connected" && state.status === "connecting") {
      window.clearTimeout(answerTimer);
      setState({ status: "connected", callId, kind, localStream: state.localStream, remoteStream: state.remoteStream, contactId });
    } else if (conn.connectionState === "failed") {
      void endCall(contactId, "failed", callId, account, store);
    }
  };

  return conn;
}

export async function startCall(contactId: string, kind: CallKind, account: LocalAccount, store: SignalStore): Promise<void> {
  cleanup();
  const callId = crypto.randomUUID();
  let localStream: MediaStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" });
  } catch {
    // No offer was ever sent, so the other side has nothing to be told about -
    // just show "Call failed" locally instead of leaving the button looking
    // like it did nothing (the previous behavior: every call site discarded
    // this rejection with `void`, so a denied permission or an insecure
    // context with no navigator.mediaDevices at all vanished silently).
    setState({ status: "ended", reason: "failed", contactId });
    scheduleIdleReset();
    return;
  }
  pc = newPeerConnection(contactId, callId, kind, account, store, await fetchTurnServer(account));
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendCallSignal(contactId, { type: "call-offer", callId, kind, sdp: offer.sdp ?? "" }, account, store);

  setState({ status: "outgoing-ringing", callId, kind, localStream, contactId });
  answerTimer = window.setTimeout(() => void endCall(contactId, "timeout", callId, account, store), ANSWER_TIMEOUT_MS);
}

export async function acceptCall(contactId: string, account: LocalAccount, store: SignalStore): Promise<void> {
  if (state.status !== "incoming-ringing" || !pendingOffer) return;
  const { callId, kind, sdp } = pendingOffer;

  let localStream: MediaStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" });
  } catch {
    // The caller already has an offer out and is sitting there ringing - tell
    // them it failed instead of letting them wait out the full answer timeout
    // for a call the callee could never actually accept.
    pendingOffer = null;
    await endCall(contactId, "failed", callId, account, store);
    return;
  }
  pc = newPeerConnection(contactId, callId, kind, account, store, await fetchTurnServer(account));
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  await pc.setRemoteDescription({ type: "offer", sdp });
  for (const candidate of pendingIceCandidates) await pc.addIceCandidate(candidate);
  pendingIceCandidates = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await sendCallSignal(contactId, { type: "call-answer", callId, sdp: answer.sdp ?? "" }, account, store);

  pendingOffer = null;
  setState({ status: "connecting", callId, kind, localStream, remoteStream: remoteStreamBuffer, contactId });
}

export async function declineCall(contactId: string, account: LocalAccount, store: SignalStore): Promise<void> {
  if (state.status !== "incoming-ringing" || !pendingOffer) return;
  await endCall(contactId, "declined", pendingOffer.callId, account, store);
}

export async function hangUp(contactId: string, account: LocalAccount, store: SignalStore): Promise<void> {
  if (state.status !== "outgoing-ringing" && state.status !== "connecting" && state.status !== "connected") return;
  const reason: CallEndReason = state.status === "outgoing-ringing" ? "cancelled" : "hangup";
  await endCall(contactId, reason, state.callId, account, store);
}

/**
 * Reacts to an incoming call-* envelope, already routed here by conversation.ts's
 * poll(). Purely reactive - every reply this state machine ever sends (answer,
 * ICE candidates, call-end) is triggered by a user action (startCall/acceptCall/
 * declineCall/hangUp) or a connection-state callback, never by receiving a signal,
 * so this never needs the contact/account/store to send anything itself.
 */
export async function handleCallSignal(envelope: CallEnvelope, senderAccountId: string): Promise<void> {
  if (envelope.type === "call-offer") {
    // ponytail: only one call at a time, matching the app's single-active-contact
    // model - an offer that arrives while already in a call is dropped rather than
    // building a busy-signal reply. Add one if a real multi-call scenario shows up.
    if (state.status !== "idle" && state.status !== "ended") return;
    pendingOffer = { callId: envelope.callId, kind: envelope.kind, sdp: envelope.sdp, callerAccountId: senderAccountId };
    pendingIceCandidates = [];
    setState({ status: "incoming-ringing", callId: envelope.callId, kind: envelope.kind, callerAccountId: senderAccountId });
    return;
  }

  if (envelope.type === "call-answer") {
    if (state.status !== "outgoing-ringing" || state.callId !== envelope.callId || !pc) return;
    window.clearTimeout(answerTimer);
    const { callId, kind, localStream, contactId } = state;
    await pc.setRemoteDescription({ type: "answer", sdp: envelope.sdp });
    for (const candidate of pendingIceCandidates) await pc.addIceCandidate(candidate);
    pendingIceCandidates = [];
    setState({ status: "connecting", callId, kind, localStream, remoteStream: remoteStreamBuffer, contactId });
    return;
  }

  if (envelope.type === "call-ice") {
    const activeCallId = pendingOffer?.callId ?? (state.status !== "idle" && state.status !== "ended" ? state.callId : undefined);
    if (activeCallId !== envelope.callId) return;
    // remoteDescription isn't set yet on the callee's side until acceptCall runs -
    // addIceCandidate throws if called first, so queue until then.
    if (pc?.remoteDescription) await pc.addIceCandidate(envelope.candidate);
    else pendingIceCandidates.push(envelope.candidate);
    return;
  }

  // call-end
  const activeCallId = pendingOffer?.callId ?? (state.status !== "idle" && state.status !== "ended" ? state.callId : undefined);
  if (activeCallId !== envelope.callId) return;
  cleanup();
  setState({ status: "ended", reason: envelope.reason, contactId: senderAccountId });
  scheduleIdleReset();
}
