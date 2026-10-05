import { useEffect, useRef, useState } from "react";
import type { SignalStore } from "wasm-crypto";
import { generateIdentity, computeSafetyNumber } from "./crypto/identity";
import { loadAccount, saveAccount, type LocalAccount } from "./storage/keyStore";
import { importBackup } from "./crypto/backup";
import { isEncryptionEnabled, isKeyUnlockEnabled, isVaultActive, unlock, unlockWithKey } from "./crypto/vault";
import { loadMessages, type ChatMessage } from "./storage/messageStore";
import { registerAccount } from "./api/register";
import { completeLink } from "./api/devices";
import { fetchDeviceActive } from "./api/chain";
import { acceptInvite, inviteFor, verifiedChain } from "./crypto/chains";
import { parseInvite } from "./crypto/invite";
import {
  startConversation,
  sendText,
  sendFile,
  markFileOpened,
  markConversationRead,
  poll,
  getTimerSeconds,
  setDisappearingTimer,
  sendTypingSignal,
  type FileSendStage,
  type FileDestruct,
} from "./chat/conversation";
import { loadTypingIndicatorEnabled } from "./storage/pushPrefsStore";
import { startCall, acceptCall, declineCall, hangUp, handleCallSignal, subscribeToCallState, getCallState, type CallState } from "./chat/call";
import { createGroup, sendGroupText, removeMember, handleGroupSignal, loadAllGroups, type Group } from "./chat/group";
import { openStore } from "./crypto/session";
import { rotateSignedPrekeysIfDue } from "./crypto/prekeyRotation";
import { loadGroup } from "./storage/groupStore";
import { CreateAccount } from "./screens/CreateAccount";
import { SafetyNumber } from "./screens/SafetyNumber";
import { TrustAlerts } from "./screens/TrustAlerts";
import { VersionMismatch } from "./screens/VersionMismatch";
import { subscribeToProtocolMismatch, type ProtocolMismatch } from "./api/protocol";
import { subscribeToTrustAlerts, dismissTrustAlert, contactSafetyNumbers, loadTrustState, type TrustAlert } from "./crypto/trust";
import { LinkedDevices } from "./screens/LinkedDevices";
import { NewConversation } from "./screens/NewConversation";
import { Conversation } from "./screens/Conversation";
import { CallScreen } from "./screens/CallScreen";
import { Groups } from "./screens/Groups";
import { GroupConversation } from "./screens/GroupConversation";
import { IncomingChats } from "./screens/IncomingChats";
import { Settings } from "./screens/Settings";
import { Unlock } from "./screens/Unlock";

const ACTIVE_CONTACT_KEY = "umbrachat:activeContactId";
const POLL_INTERVAL_MS = 3000;
const CALL_POLL_INTERVAL_MS = 500;
// Rotation itself is due weekly (crypto/prekeyRotation.ts); checking is a local date comparison.
const PREKEY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function isRinging(callState: CallState): boolean {
  return callState.status === "outgoing-ringing" || callState.status === "incoming-ringing";
}

type Status =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "anonymous" }
  | { status: "identity-ready"; account: LocalAccount; safetyNumber: string; groups: Group[] }
  | { status: "conversation"; account: LocalAccount; contactId: string; store: SignalStore; messages: ChatMessage[] }
  | { status: "group"; account: LocalAccount; group: Group; store: SignalStore; messages: ChatMessage[] }
  | { status: "settings"; account: LocalAccount };

// A background poll that fails (server unreachable, this device removed from its account) is retried at
// the next tick; it must not surface as an uncaught error.
const onPollError = (err: unknown) => console.warn("poll failed:", err);

const LINK_POLL_MS = 2000;
const LINK_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function App() {
  const [state, setState] = useState<Status>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  // While this device waits for another one to accept it: the key fingerprint to compare there.
  const [linkFingerprint, setLinkFingerprint] = useState<string>();
  const linkCancelled = useRef(false);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [fileStage, setFileStage] = useState<FileSendStage>();
  const [callState, setCallState] = useState<CallState>(getCallState());
  const [timerSeconds, setTimerSecondsState] = useState(0);
  const [error, setError] = useState<string>();
  // Senders who've messaged while idle on the identity-ready screen, that
  // haven't been opened yet - lets the recipient side of a new conversation
  // find out without already knowing to type the sender's account id first.
  const [pendingChats, setPendingChats] = useState<string[]>([]);
  const pollTimer = useRef<number>(undefined);
  const pollIntervalRef = useRef(POLL_INTERVAL_MS);
  const lastTypingSentRef = useRef(0);
  // Whichever screen's runPoll is currently active - iOS Safari (and other
  // mobile browsers) suspend setInterval almost entirely in a backgrounded
  // tab, so a message sent while the tab was in the background can sit
  // un-polled long after it arrives server-side. Firing one poll the moment
  // the tab becomes visible again catches up immediately instead of waiting
  // for the next interval tick, which may not come for a while.
  const [trustAlerts, setTrustAlerts] = useState<TrustAlert[]>([]);
  const [protocolMismatch, setProtocolMismatch] = useState<ProtocolMismatch>();
  const activePollRef = useRef<() => Promise<void>>(undefined);

  useEffect(() => subscribeToCallState(setCallState), []);
  useEffect(() => subscribeToTrustAlerts(setTrustAlerts), []);
  useEffect(() => subscribeToProtocolMismatch(setProtocolMismatch), []);
  const signedIn = "account" in state;
  useEffect(() => {
    if (signedIn) loadTrustState().catch((err) => console.error("loadTrustState failed:", err));
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn) return;
    const rotate = () => void rotateSignedPrekeysIfDue().catch((err) => console.warn("prekey rotation failed, retrying later:", err));
    rotate();
    const timer = window.setInterval(rotate, PREKEY_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [signedIn]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void activePollRef.current?.();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // The real boot logic - reused both when encryption is off (runs directly)
  // and after a successful unlock (runs once the vault key is active).
  async function bootIntoAccount() {
    const existing = await loadAccount();
    if (!existing) {
      setState({ status: "anonymous" });
      return;
    }
    const activeContactId = localStorage.getItem(ACTIVE_CONTACT_KEY);
    if (activeContactId) {
      await enterConversation(existing, activeContactId);
      return;
    }
    await enterIdentityReady(existing);
  }

  useEffect(() => {
    // Checked before calling loadAccount() at all - loadAccount() decrypts
    // through the vault, which throws if encryption is on but nothing has
    // unlocked it yet (isVaultActive() is false right after a fresh page
    // load, always - the key only ever lives in memory, never localStorage).
    if (isEncryptionEnabled() && !isVaultActive()) {
      setState({ status: "locked" });
    } else {
      void bootIntoAccount();
    }

    return () => window.clearInterval(pollTimer.current);
  }, []);

  async function handleUnlock(passphrase: string): Promise<boolean> {
    const ok = await unlock(passphrase, loadAccount);
    if (ok) await bootIntoAccount();
    return ok;
  }

  async function handleUnlockWithKey(): Promise<boolean> {
    const ok = await unlockWithKey(loadAccount);
    if (ok) await bootIntoAccount();
    return ok;
  }

  // Shares the same pollTimer as enterConversation/enterGroup - a group invite
  // has to be discoverable from here too (there's otherwise no way to learn
  // about one without already knowing its groupId, or happening to have some
  // unrelated 1:1 conversation open). Screens are mutually exclusive in this
  // app, so there's no concurrent-poller risk in giving this one its own turn.
  // Fires from any screen's poll, not just the identity-ready one - most real
  // sessions resume straight into a cached conversation (see ACTIVE_CONTACT_KEY
  // below) and never touch identity-ready at all, so a notice that only fired
  // from there would almost never actually surface. pendingChats itself is
  // only ever rendered on the identity-ready screen, so an entry captured
  // elsewhere just waits quietly until the user navigates back to it.
  function addPendingChat(senderId: string) {
    setPendingChats((prev) => (prev.includes(senderId) ? prev : [...prev, senderId]));
  }

  async function enterIdentityReady(account: LocalAccount) {
    const safetyNumber = await computeSafetyNumber(account.identity.identity_public_key);
    const groups = await loadAllGroups();
    setState({ status: "identity-ready", account, safetyNumber, groups });

    const store = await openStore(account.identity);
    const runPoll = async () => {
      await poll(undefined, account, store, handleCallSignal, handleGroupSignal, addPendingChat);
      const updatedGroups = await loadAllGroups();
      setState((s) => (s.status === "identity-ready" ? { ...s, groups: updatedGroups } : s));
    };
    activePollRef.current = runPoll;

    window.clearInterval(pollTimer.current);
    pollTimer.current = undefined;
    pollIntervalRef.current = POLL_INTERVAL_MS;
    await runPoll();
    pollTimer.current = window.setInterval(() => void runPoll().catch(onPollError), POLL_INTERVAL_MS);
  }

  async function enterConversation(account: LocalAccount, contactId: string): Promise<SignalStore> {
    const store = await startConversation(contactId, account);
    const messages = await loadMessages(contactId);
    setState({ status: "conversation", account, contactId, store, messages });
    setTimerSecondsState(getTimerSeconds(contactId));
    localStorage.setItem(ACTIVE_CONTACT_KEY, contactId);

    // The user is actually looking at this conversation now - this is the
    // real "read" moment, not whenever a background poll happened to
    // decrypt a message from a sender nobody had opened yet (see
    // markConversationRead's doc comment for the presence-oracle it fixes).
    const readMessages = await markConversationRead(contactId, account, store);
    setState((s) => (s.status === "conversation" && s.contactId === contactId ? { ...s, messages: readMessages } : s));

    const runPoll = async () => {
      const updated = await poll(contactId, account, store, handleCallSignal, handleGroupSignal, addPendingChat);
      setState((s) => (s.status === "conversation" ? { ...s, messages: updated } : s));
      setTimerSecondsState(getTimerSeconds(contactId));

      // Ringing needs faster signaling round trips than the normal message-poll
      // interval. This is the only place that schedules the interval (including
      // the very first time), so there's never more than one running at once.
      const desiredInterval = isRinging(getCallState()) ? CALL_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      if (desiredInterval !== pollIntervalRef.current || pollTimer.current === undefined) {
        pollIntervalRef.current = desiredInterval;
        window.clearInterval(pollTimer.current);
        pollTimer.current = window.setInterval(() => void runPoll().catch(onPollError), desiredInterval);
      }
    };
    activePollRef.current = runPoll;

    window.clearInterval(pollTimer.current);
    pollTimer.current = undefined;
    // setInterval only fires after a full interval elapses - poll once immediately
    // too, so messages queued while offline show up on reconnect without delay.
    await runPoll();
    return store;
  }

  // Shares the exact same pollTimer/pollIntervalRef as enterConversation -
  // GET /v1/messages is fetch-and-delete, so two independent poll loops would
  // race to consume the same queued messages. Only one is ever active.
  async function enterGroup(account: LocalAccount, groupId: string) {
    const group = await loadGroup(groupId);
    if (!group) return;
    const store = await openStore(account.identity);
    const messages = await loadMessages(groupId);
    setState({ status: "group", account, group, store, messages });

    const runPoll = async () => {
      // poll()'s own return value is always [] with no contactId - a group's
      // messages are written straight to storage by handleGroupSignal instead,
      // so they're reloaded from there, not taken from poll()'s result.
      await poll(undefined, account, store, handleCallSignal, handleGroupSignal, addPendingChat);
      const [refreshedGroup, updatedMessages] = await Promise.all([loadGroup(groupId), loadMessages(groupId)]);
      setState((s) => (s.status === "group" && refreshedGroup ? { ...s, group: refreshedGroup, messages: updatedMessages } : s));
    };
    activePollRef.current = runPoll;

    window.clearInterval(pollTimer.current);
    pollTimer.current = undefined;
    pollIntervalRef.current = POLL_INTERVAL_MS;
    await runPoll();
    pollTimer.current = window.setInterval(() => void runPoll().catch(onPollError), POLL_INTERVAL_MS);
  }

  async function handleCreate() {
    setCreating(true);
    setError(undefined);
    try {
      const identity = await generateIdentity();
      const { accountId, deviceId } = await registerAccount(identity);
      const account: LocalAccount = { accountId, deviceId, identity };
      await saveAccount(account);
      await enterIdentityReady(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : "registration failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleLinkDevice(accountId: string, code: string) {
    setCreating(true);
    setError(undefined);
    try {
      const identity = await generateIdentity();
      const deviceId = await completeLink(accountId, code, "Linked Device", identity);
      const account: LocalAccount = { accountId, deviceId, identity };
      // The key went through the server, so it is accepted only once a device already in the account
      // has shown the user this same fingerprint and signed a statement that includes it.
      linkCancelled.current = false;
      setLinkFingerprint(await computeSafetyNumber(identity.identity_public_key));
      const deadline = Date.now() + LINK_APPROVAL_TIMEOUT_MS;
      while (!(await fetchDeviceActive(deviceId))) {
        if (linkCancelled.current) throw new Error("linking cancelled");
        if (Date.now() > deadline) throw new Error("no device accepted this one in time, start again");
        await new Promise((resolve) => window.setTimeout(resolve, LINK_POLL_MS));
      }
      await verifiedChain(accountId, account); // throws unless the signed list really holds this device's key
      await saveAccount(account);
      await enterIdentityReady(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to link device");
    } finally {
      setLinkFingerprint(undefined);
      setCreating(false);
    }
  }

  async function handleRestore(file: File, passphrase: string) {
    setCreating(true);
    setError(undefined);
    try {
      const account = await importBackup(file, passphrase);
      await enterIdentityReady(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to restore backup");
    } finally {
      setCreating(false);
    }
  }

  async function handleStartConversation(entered: string) {
    if (state.status !== "identity-ready") return;
    const invite = parseInvite(entered);
    const contactId = invite ? invite.accountId : entered;
    if (contactId === state.account.accountId) {
      setError("that's your own account id - enter a contact's id instead");
      return;
    }
    setStarting(true);
    setError(undefined);
    try {
      if (invite) await acceptInvite(invite, state.account);
      await enterConversation(state.account, contactId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start conversation");
    } finally {
      setStarting(false);
    }
  }

  async function handleSend(text: string) {
    if (state.status !== "conversation") return;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendText(state.contactId, text, state.account, state.store);
      setState((s) => (s.status === "conversation" ? { ...s, messages } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function handleSendFile(file: File, destruct?: FileDestruct) {
    if (state.status !== "conversation") return;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendFile(state.contactId, file, state.account, state.store, setFileStage, destruct);
      setState((s) => (s.status === "conversation" ? { ...s, messages } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send file");
    } finally {
      setSending(false);
      setFileStage(undefined);
    }
  }

  async function handleOpenFile(messageId: string) {
    if (state.status !== "conversation") return;
    const messages = await markFileOpened(state.contactId, messageId, state.account, state.store);
    setState((s) => (s.status === "conversation" ? { ...s, messages } : s));
  }

  async function handleSetTimer(seconds: number) {
    if (state.status !== "conversation") return;
    setTimerSecondsState(seconds);
    await setDisappearingTimer(state.contactId, seconds, state.account, state.store);
  }

  // No point sending faster than the recipient's own poll interval would ever
  // surface it - checked at call time (not cached) so flipping the Settings
  // toggle off takes effect on the very next keystroke.
  async function handleTyping() {
    if (state.status !== "conversation") return;
    if (!(await loadTypingIndicatorEnabled())) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < POLL_INTERVAL_MS) return;
    lastTypingSentRef.current = now;
    await sendTypingSignal(state.contactId, state.account, state.store).catch((err) => console.error("sendTypingSignal failed:", err));
  }

  async function handleCreateGroup(name: string, memberAccountIds: string[]) {
    if (state.status !== "identity-ready") return;
    setCreating(true);
    setError(undefined);
    try {
      const store = await openStore(state.account.identity);
      await createGroup(name, memberAccountIds, state.account, store);
      const groups = await loadAllGroups();
      setState((s) => (s.status === "identity-ready" ? { ...s, groups } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create group");
    } finally {
      setCreating(false);
    }
  }

  async function handleOpenGroup(groupId: string) {
    if (state.status !== "identity-ready") return;
    await enterGroup(state.account, groupId);
  }

  async function handleSendGroupText(text: string) {
    if (state.status !== "group") return;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendGroupText(state.group.id, text, state.account, state.store);
      setState((s) => (s.status === "group" ? { ...s, messages } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send group message");
    } finally {
      setSending(false);
    }
  }

  async function handleOpenPendingChat(contactId: string) {
    if (state.status !== "identity-ready") return;
    setPendingChats((prev) => prev.filter((id) => id !== contactId));
    await enterConversation(state.account, contactId);
  }

  async function handleBackToMenu() {
    if (state.status !== "conversation" && state.status !== "group" && state.status !== "settings") return;
    localStorage.removeItem(ACTIVE_CONTACT_KEY);
    await enterIdentityReady(state.account);
  }

  function handleOpenSettings() {
    if (state.status !== "identity-ready") return;
    setState({ status: "settings", account: state.account });
  }

  async function handleRemoveMember(memberAccountId: string) {
    if (state.status !== "group") return;
    setError(undefined);
    try {
      const group = await removeMember(state.group.id, memberAccountId, state.account, state.store);
      setState((s) => (s.status === "group" ? { ...s, group } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to remove member");
    }
  }

  async function callContext() {
    if (!("account" in state)) return undefined;
    const store = state.status === "conversation" || state.status === "group" ? state.store : await openStore(state.account.identity);
    return { account: state.account, store };
  }

  async function handleAcceptCall() {
    if (!("account" in state) || callState.status !== "incoming-ringing") return;
    const peer = callState.callerAccountId;
    const store = state.status === "conversation" && state.contactId === peer ? state.store : await enterConversation(state.account, peer);
    await acceptCall(peer, state.account, store);
  }

  async function handleDeclineCall() {
    const ctx = await callContext();
    if (ctx && callState.status === "incoming-ringing") await declineCall(callState.callerAccountId, ctx.account, ctx.store);
  }

  async function handleHangUpCall() {
    const ctx = await callContext();
    if (ctx && (callState.status === "outgoing-ringing" || callState.status === "connecting" || callState.status === "connected")) {
      await hangUp(callState.contactId, ctx.account, ctx.store);
    }
  }

  const callScreen =
    callState.status !== "idle" && "account" in state ? (
      <CallScreen
        callState={callState}
        onAccept={() => handleAcceptCall().catch((err) => console.error("acceptCall failed:", err))}
        onDecline={() => handleDeclineCall().catch((err) => console.error("declineCall failed:", err))}
        onHangUp={() => handleHangUpCall().catch((err) => console.error("hangUp failed:", err))}
      />
    ) : null;

  const callOverlay = (
    <>
      <TrustAlerts alerts={trustAlerts} onDismiss={dismissTrustAlert} />
      {callScreen}
    </>
  );

  // A server on another version: nothing may be sent or shown as working until both match.
  if (protocolMismatch) {
    return (
      <div className="app-shell">
        <VersionMismatch mismatch={protocolMismatch} />
      </div>
    );
  }

  if (state.status === "loading") return null;

  if (state.status === "locked") {
    return (
      <div className="app-shell">
        <Unlock onUnlock={handleUnlock} onUnlockWithKey={isKeyUnlockEnabled() ? handleUnlockWithKey : undefined} />
      </div>
    );
  }

  if (state.status === "anonymous") {
    return (
      <div className="app-shell">
        <CreateAccount onCreate={handleCreate} onLink={handleLinkDevice} onRestore={handleRestore} creating={creating} error={error} linkFingerprint={linkFingerprint} onCancelLink={() => (linkCancelled.current = true)} />
      </div>
    );
  }

  if (state.status === "identity-ready") {
    return (
      <div className="app-shell">
        {callOverlay}
        <div className="screen">
          <h1>UmbraChat</h1>
          <IncomingChats pendingChats={pendingChats} onOpen={handleOpenPendingChat} />
          <SafetyNumber accountId={state.account.accountId} safetyNumber={state.safetyNumber} onGetInvite={() => inviteFor(state.account)} />
          <LinkedDevices account={state.account} />
          <Groups groups={state.groups} ownAccountId={state.account.accountId} onCreateGroup={handleCreateGroup} onOpenGroup={handleOpenGroup} creating={creating} error={error} />
          <NewConversation onStart={handleStartConversation} starting={starting} error={error} />
          <button className="secondary" onClick={handleOpenSettings}>
            Settings
          </button>
        </div>
      </div>
    );
  }

  if (state.status === "settings") {
    return (
      <div className="app-shell">
        {callOverlay}
        <Settings account={state.account} onBack={handleBackToMenu} />
      </div>
    );
  }

  if (state.status === "group") {
    return (
      <div className="app-shell">
        {callOverlay}
        <GroupConversation
          group={state.group}
          account={state.account}
          messages={state.messages}
          onSend={handleSendGroupText}
          onRemoveMember={handleRemoveMember}
          onBack={handleBackToMenu}
          sending={sending}
          error={error}
        />
      </div>
    );
  }

  const { contactId, account, store } = state;

  return (
    <div className="app-shell">
      {callOverlay}
      <Conversation
        contactId={contactId}
        messages={state.messages}
        onSend={handleSend}
        onSendFile={handleSendFile}
        onOpenFile={handleOpenFile}
        onStartCall={(kind) => startCall(contactId, kind, account, store).catch((err) => console.error("startCall failed:", err))}
        onSetTimer={handleSetTimer}
        onTyping={handleTyping}
        onBack={handleBackToMenu}
        onLoadFingerprints={() => contactSafetyNumbers(contactId, account, store)}
        sending={sending}
        fileStage={fileStage}
        callActive={callState.status !== "idle" && callState.status !== "ended"}
        timerSeconds={timerSeconds}
        error={error}
      />
    </div>
  );
}

export default App;
