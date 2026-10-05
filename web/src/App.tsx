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
import { TrustAlerts } from "./screens/TrustAlerts";
import { VersionMismatch } from "./screens/VersionMismatch";
import { subscribeToProtocolMismatch, type ProtocolMismatch } from "./api/protocol";
import { subscribeToTrustAlerts, dismissTrustAlert, contactSafetyNumbers, loadTrustState, type TrustAlert } from "./crypto/trust";
import { Conversation } from "./screens/Conversation";
import { CallScreen } from "./screens/CallScreen";
import { GroupConversation } from "./screens/GroupConversation";
import { ChatList } from "./screens/ChatList";
import { Me } from "./screens/Me";
import { TabBar, type Tab } from "./screens/TabBar";
import { Toast, showToast } from "./screens/Toast";
import { useChatList, type ChatEntry } from "./screens/useChatList";
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

type Open =
  | { kind: "contact"; contactId: string; store: SignalStore; messages: ChatMessage[] }
  | { kind: "group"; group: Group; store: SignalStore; messages: ChatMessage[] };

type Status =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "anonymous" }
  | { status: "ready"; account: LocalAccount; safetyNumber: string; open?: Open };

/** How the main pane enters: deeper (a chat opened), back out, or sideways (another tab). */
type NavDir = "fwd" | "back" | "fade";

// A background poll that fails (server unreachable, this device removed from its account) is retried at
// the next tick; it must not surface as an uncaught error.
const onPollError = (err: unknown) => console.warn("poll failed:", err);

const LINK_POLL_MS = 2000;
const LINK_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function App() {
  const [state, setState] = useState<Status>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("chats");
  const [groups, setGroups] = useState<Group[]>([]);
  const [navDir, setNavDir] = useState<NavDir>("fade");
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
  // Starting a chat or a group fails inside the New chat sheet, not in the open chat.
  const [listError, setListError] = useState<string>();
  const pollTimer = useRef<number>(undefined);
  const pollIntervalRef = useRef(POLL_INTERVAL_MS);
  const lastTypingSentRef = useRef(0);
  // Bumped on every navigation. With two panes, going straight from one chat to another is
  // common: a poll or a load started for the previous screen must neither write its result
  // into the new one nor schedule the poll loop again. Each checks its number first.
  const navSeq = useRef(0);
  const [trustAlerts, setTrustAlerts] = useState<TrustAlert[]>([]);
  const [protocolMismatch, setProtocolMismatch] = useState<ProtocolMismatch>();
  // Whichever screen's runPoll is currently active - iOS Safari (and other
  // mobile browsers) suspend setInterval almost entirely in a backgrounded
  // tab, so a message sent while the tab was in the background can sit
  // un-polled long after it arrives server-side. Firing one poll the moment
  // the tab becomes visible again catches up immediately instead of waiting
  // for the next interval tick, which may not come for a while.
  const activePollRef = useRef<() => Promise<void>>(undefined);

  const account = state.status === "ready" ? state.account : undefined;
  const open = state.status === "ready" ? state.open : undefined;
  const openId = open ? (open.kind === "contact" ? open.contactId : open.group.id) : undefined;
  const { entries, refreshNicknames } = useChatList(account?.accountId, groups, openId);

  useEffect(() => subscribeToCallState(setCallState), []);
  useEffect(() => subscribeToTrustAlerts(setTrustAlerts), []);
  useEffect(() => subscribeToProtocolMismatch(setProtocolMismatch), []);
  const signedIn = account !== undefined;
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
    await signIn(existing, "chats");
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

  // A new account lands on Me, where its invite is; a returning one on its chats,
  // straight back into the conversation it left open.
  async function signIn(account: LocalAccount, landing: Tab) {
    const [safetyNumber, allGroups] = await Promise.all([computeSafetyNumber(account.identity.identity_public_key), loadAllGroups()]);
    setGroups(allGroups);
    setTab(landing);
    setState({ status: "ready", account, safetyNumber });
    const activeContactId = landing === "chats" ? localStorage.getItem(ACTIVE_CONTACT_KEY) : null;
    if (activeContactId) await enterConversation(account, activeContactId, "fade");
    else await enterHome(account, "fade");
  }

  function beginNav(dir: NavDir): number {
    navSeq.current += 1;
    setNavDir(dir);
    setError(undefined);
    // Nothing polls while the next screen loads; that screen starts its own loop.
    window.clearInterval(pollTimer.current);
    pollTimer.current = undefined;
    activePollRef.current = undefined;
    return navSeq.current;
  }

  // GET /v1/messages is fetch-and-delete, so two independent poll loops would race to consume
  // the same queued messages: there is only ever one, owned by the current screen.
  function beginPolling(seq: number, tick: () => Promise<void>) {
    const runPoll = async () => {
      try {
        await tick();
      } finally {
        // Ringing needs faster signaling round trips than the normal message-poll interval.
        // This is the only place that schedules the interval, so there's never more than one.
        const desiredInterval = isRinging(getCallState()) ? CALL_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
        if (seq === navSeq.current && (desiredInterval !== pollIntervalRef.current || pollTimer.current === undefined)) {
          pollIntervalRef.current = desiredInterval;
          window.clearInterval(pollTimer.current);
          pollTimer.current = window.setInterval(() => void runPoll().catch(onPollError), desiredInterval);
        }
      }
    };
    activePollRef.current = runPoll;
    // setInterval only fires after a full interval elapses - poll once immediately
    // too, so messages queued while offline show up on reconnect without delay.
    // Not awaited: the screen is usable before the server answers, and a failure is retried.
    void runPoll().catch(onPollError);
  }

  // A group invite or roster change can arrive from any screen: the list follows it.
  async function onGroupSignal(...args: Parameters<typeof handleGroupSignal>) {
    await handleGroupSignal(...args);
    setGroups(await loadAllGroups());
  }

  async function enterHome(account: LocalAccount, dir: NavDir) {
    const seq = beginNav(dir);
    localStorage.removeItem(ACTIVE_CONTACT_KEY);
    setState((s) => (s.status === "ready" ? { ...s, open: undefined } : s));
    const store = await openStore(account.identity);
    if (seq !== navSeq.current) return;
    beginPolling(seq, async () => {
      await poll(undefined, account, store, handleCallSignal, onGroupSignal);
    });
  }

  async function enterConversation(account: LocalAccount, contactId: string, dir: NavDir): Promise<SignalStore> {
    const seq = beginNav(dir);
    const stale = () => seq !== navSeq.current;
    let store: SignalStore;
    let messages: ChatMessage[];
    try {
      store = await startConversation(contactId, account);
      messages = await loadMessages(contactId);
    } catch (err) {
      // The previous screen's loop is stopped already: fall back to the list rather than poll nothing.
      if (!stale()) void enterHome(account, "back").catch(onPollError);
      throw err;
    }
    if (stale()) return store;
    setState((s) => (s.status === "ready" ? { ...s, open: { kind: "contact", contactId, store, messages } } : s));
    setTab("chats");
    setTimerSecondsState(getTimerSeconds(contactId));
    localStorage.setItem(ACTIVE_CONTACT_KEY, contactId);

    const setMessages = (messages: ChatMessage[]) => {
      if (stale()) return;
      setState((s) => (s.status === "ready" && s.open?.kind === "contact" && s.open.contactId === contactId ? { ...s, open: { ...s.open, messages } } : s));
    };
    // The user is actually looking at this conversation now - this is the
    // real "read" moment, not whenever a background poll happened to
    // decrypt a message from a sender nobody had opened yet (see
    // markConversationRead's doc comment for the presence-oracle it fixes).
    setMessages(await markConversationRead(contactId, account, store));
    if (stale()) return store;

    beginPolling(seq, async () => {
      const updated = await poll(contactId, account, store, handleCallSignal, onGroupSignal);
      if (stale()) return;
      setMessages(updated);
      setTimerSecondsState(getTimerSeconds(contactId));
    });
    return store;
  }

  async function enterGroup(account: LocalAccount, groupId: string, dir: NavDir) {
    const seq = beginNav(dir);
    const stale = () => seq !== navSeq.current;
    let group: Group | undefined;
    let store: SignalStore;
    let messages: ChatMessage[];
    try {
      [group, store, messages] = await Promise.all([loadGroup(groupId), openStore(account.identity), loadMessages(groupId)]);
      if (!group) throw new Error("that group is not on this device");
    } catch (err) {
      if (!stale()) void enterHome(account, "back").catch(onPollError);
      throw err;
    }
    if (stale()) return;
    localStorage.removeItem(ACTIVE_CONTACT_KEY);
    setState((s) => (s.status === "ready" ? { ...s, open: { kind: "group", group, store, messages } } : s));
    setTab("chats");

    beginPolling(seq, async () => {
      // poll()'s own return value is always [] with no contactId - a group's
      // messages are written straight to storage by handleGroupSignal instead,
      // so they're reloaded from there, not taken from poll()'s result.
      await poll(undefined, account, store, handleCallSignal, onGroupSignal);
      const [refreshedGroup, updatedMessages] = await Promise.all([loadGroup(groupId), loadMessages(groupId)]);
      if (stale() || !refreshedGroup) return;
      setState((s) => (s.status === "ready" && s.open?.kind === "group" && s.open.group.id === groupId ? { ...s, open: { ...s.open, group: refreshedGroup, messages: updatedMessages } } : s));
    });
  }

  async function handleCreate() {
    setCreating(true);
    setError(undefined);
    try {
      const identity = await generateIdentity();
      const { accountId, deviceId } = await registerAccount(identity);
      const account: LocalAccount = { accountId, deviceId, identity };
      await saveAccount(account);
      await signIn(account, "me");
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
      await signIn(account, "me");
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
      await signIn(account, "me");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to restore backup");
    } finally {
      setCreating(false);
    }
  }

  async function handleStartConversation(entered: string): Promise<boolean> {
    if (state.status !== "ready") return false;
    const invite = parseInvite(entered);
    const contactId = invite ? invite.accountId : entered;
    if (contactId === state.account.accountId) {
      setListError("that's your own account id - enter a contact's id instead");
      return false;
    }
    setStarting(true);
    setListError(undefined);
    try {
      if (invite) await acceptInvite(invite, state.account);
      await enterConversation(state.account, contactId, "fwd");
      return true;
    } catch (err) {
      setListError(err instanceof Error ? err.message : "failed to start conversation");
      return false;
    } finally {
      setStarting(false);
    }
  }

  function handleOpenChat(entry: ChatEntry) {
    if (state.status !== "ready" || entry.id === openId) return;
    const opening = entry.kind === "group" ? enterGroup(state.account, entry.id, "fwd") : enterConversation(state.account, entry.id, "fwd");
    opening.catch((err) => showToast(err instanceof Error ? err.message : "could not open this chat"));
  }

  function handleBackToMenu() {
    if (state.status !== "ready") return;
    void enterHome(state.account, "back").catch(onPollError);
  }

  function selectTab(next: Tab) {
    if (state.status !== "ready" || (next === tab && !open)) return;
    setTab(next);
    if (open) void enterHome(state.account, "fade").catch(onPollError);
    else setNavDir("fade");
  }

  async function handleSend(text: string) {
    if (open?.kind !== "contact" || !account) return;
    const { contactId, store } = open;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendText(contactId, text, account, store);
      setState((s) => (s.status === "ready" && s.open?.kind === "contact" && s.open.contactId === contactId ? { ...s, open: { ...s.open, messages } } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function handleSendFile(file: File, destruct?: FileDestruct) {
    if (open?.kind !== "contact" || !account) return;
    const { contactId, store } = open;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendFile(contactId, file, account, store, setFileStage, destruct);
      setState((s) => (s.status === "ready" && s.open?.kind === "contact" && s.open.contactId === contactId ? { ...s, open: { ...s.open, messages } } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send file");
    } finally {
      setSending(false);
      setFileStage(undefined);
    }
  }

  async function handleOpenFile(messageId: string) {
    if (open?.kind !== "contact" || !account) return;
    const { contactId, store } = open;
    const messages = await markFileOpened(contactId, messageId, account, store);
    setState((s) => (s.status === "ready" && s.open?.kind === "contact" && s.open.contactId === contactId ? { ...s, open: { ...s.open, messages } } : s));
  }

  async function handleSetTimer(seconds: number) {
    if (open?.kind !== "contact" || !account) return;
    setTimerSecondsState(seconds);
    await setDisappearingTimer(open.contactId, seconds, account, open.store);
  }

  // No point sending faster than the recipient's own poll interval would ever
  // surface it - checked at call time (not cached) so flipping the Settings
  // toggle off takes effect on the very next keystroke.
  async function handleTyping() {
    if (open?.kind !== "contact" || !account) return;
    if (!(await loadTypingIndicatorEnabled())) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < POLL_INTERVAL_MS) return;
    lastTypingSentRef.current = now;
    await sendTypingSignal(open.contactId, account, open.store).catch((err) => console.error("sendTypingSignal failed:", err));
  }

  async function handleCreateGroup(name: string, memberAccountIds: string[]): Promise<boolean> {
    if (!account) return false;
    setCreating(true);
    setListError(undefined);
    try {
      const store = await openStore(account.identity);
      await createGroup(name, memberAccountIds, account, store);
      setGroups(await loadAllGroups());
      return true;
    } catch (err) {
      setListError(err instanceof Error ? err.message : "failed to create group");
      return false;
    } finally {
      setCreating(false);
    }
  }

  async function handleSendGroupText(text: string) {
    if (open?.kind !== "group" || !account) return;
    const { group, store } = open;
    setSending(true);
    setError(undefined);
    try {
      const messages = await sendGroupText(group.id, text, account, store);
      setState((s) => (s.status === "ready" && s.open?.kind === "group" && s.open.group.id === group.id ? { ...s, open: { ...s.open, messages } } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to send group message");
    } finally {
      setSending(false);
    }
  }

  async function handleRemoveMember(memberAccountId: string) {
    if (open?.kind !== "group" || !account) return;
    const { store } = open;
    const groupId = open.group.id;
    setError(undefined);
    try {
      const group = await removeMember(groupId, memberAccountId, account, store);
      setGroups(await loadAllGroups());
      setState((s) => (s.status === "ready" && s.open?.kind === "group" && s.open.group.id === groupId ? { ...s, open: { ...s.open, group } } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to remove member");
    }
  }

  async function callContext() {
    if (!account) return undefined;
    return { account, store: open?.store ?? (await openStore(account.identity)) };
  }

  async function handleAcceptCall() {
    if (!account || callState.status !== "incoming-ringing") return;
    const peer = callState.callerAccountId;
    const store = open?.kind === "contact" && open.contactId === peer ? open.store : await enterConversation(account, peer, "fwd");
    await acceptCall(peer, account, store);
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

  let main: React.ReactNode;
  if (open?.kind === "contact") {
    const { contactId, store } = open;
    main = (
      <Conversation
        contactId={contactId}
        messages={open.messages}
        onSend={handleSend}
        onSendFile={handleSendFile}
        onOpenFile={handleOpenFile}
        onStartCall={(kind) => startCall(contactId, kind, state.account, store).catch((err) => console.error("startCall failed:", err))}
        onSetTimer={handleSetTimer}
        onTyping={handleTyping}
        onBack={handleBackToMenu}
        onLoadFingerprints={() => contactSafetyNumbers(contactId, state.account, store)}
        onNicknameChange={refreshNicknames}
        sending={sending}
        fileStage={fileStage}
        callActive={callState.status !== "idle" && callState.status !== "ended"}
        timerSeconds={timerSeconds}
        error={error}
      />
    );
  } else if (open?.kind === "group") {
    main = (
      <GroupConversation
        group={open.group}
        account={state.account}
        messages={open.messages}
        onSend={handleSendGroupText}
        onRemoveMember={handleRemoveMember}
        onBack={handleBackToMenu}
        sending={sending}
        error={error}
      />
    );
  } else if (tab === "me") {
    main = <Me account={state.account} safetyNumber={state.safetyNumber} onGetInvite={() => inviteFor(state.account)} />;
  } else if (tab === "settings") {
    main = <Settings account={state.account} />;
  } else {
    main = <p className="pane-empty">Pick a chat, or start one with New chat.</p>;
  }

  // On a phone one pane shows at a time: the list on Chats with nothing open, the other pane otherwise.
  const pane = !open && tab === "chats" ? "side" : "main";

  return (
    <div className="app" data-pane={pane} data-chat={open ? "open" : undefined}>
      <TrustAlerts alerts={trustAlerts} onDismiss={dismissTrustAlert} />
      {callState.status !== "idle" && (
        <CallScreen
          callState={callState}
          onAccept={() => handleAcceptCall().catch((err) => console.error("acceptCall failed:", err))}
          onDecline={() => handleDeclineCall().catch((err) => console.error("declineCall failed:", err))}
          onHangUp={() => handleHangUpCall().catch((err) => console.error("hangUp failed:", err))}
        />
      )}
      <aside className="side">
        <ChatList
          entries={entries}
          activeId={openId}
          ownAccountId={state.account.accountId}
          onOpen={handleOpenChat}
          onStart={handleStartConversation}
          onCreateGroup={handleCreateGroup}
          busy={starting || creating}
          error={listError}
        />
      </aside>
      <TabBar tab={tab} onSelect={selectTab} unread={entries.some((e) => e.unread)} />
      <div className={`main enter-${navDir}`} key={openId ?? tab}>
        {main}
      </div>
      <Toast />
    </div>
  );
}

export default App;
