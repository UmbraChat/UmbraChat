import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../storage/messageStore";
import { isFileTooLarge, subscribeToTypingState, resetTypingState, type FileDestruct, type FileSendStage } from "../chat/conversation";
import type { DeviceFingerprint } from "../crypto/trust";
import { loadNickname, saveNickname } from "../storage/nicknameStore";
import { Composer } from "./Composer";
import { Sheet } from "./Sheet";
import { showToast } from "./Toast";
import { MoreIcon, PhoneIcon, VideoIcon } from "./icons";

interface ConversationProps {
  contactId: string;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onSendFile: (file: File, destruct?: FileDestruct) => void;
  onOpenFile: (messageId: string) => void;
  onStartCall: (kind: "voice" | "video") => void;
  onSetTimer: (seconds: number) => void;
  onTyping: () => void;
  onBack: () => void;
  onLoadFingerprints: () => Promise<DeviceFingerprint[]>;
  onNicknameChange: () => void;
  /** Deletes this device's copy of the chat and leaves it. */
  onDelete: () => void;
  sending: boolean;
  fileStage?: FileSendStage;
  callActive: boolean;
  timerSeconds: number;
  error?: string;
}

const TIMER_OPTIONS: [number, string][] = [
  [0, "Off"],
  [30, "30s"],
  [5 * 60, "5m"],
  [60 * 60, "1h"],
  [24 * 60 * 60, "1d"],
];

// "on-open" is its own sentinel value distinct from the numeric timers.
const DESTRUCT_OPTIONS: [string, string][] = [
  ["none", "Keep it"],
  ["on-open", "After opening"],
  ["30", "After 30s"],
  ["300", "After 5m"],
  ["3600", "After 1h"],
];

function destructFromOption(value: string): FileDestruct | undefined {
  if (value === "none") return undefined;
  if (value === "on-open") return { onOpen: true };
  return { afterSeconds: Number(value) };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const SAFE_IMAGE_TYPE = /^image\/(png|jpeg|gif|webp|avif)$/;

function FileMessage({ message, onOpenFile }: { message: ChatMessage; onOpenFile: (messageId: string) => void }) {
  const file = message.file!;
  // Keyed on message.id, not file.bytes: messages reload fresh from storage on
  // every poll, so the Uint8Array reference changes even when the content
  // hasn't - id is the stable identity.
  //
  // ponytail: deliberately never revoked. React StrictMode's dev-mode double
  // effect invocation (mount -> cleanup -> mount) would revoke this on the
  // first render without useMemo re-running to replace it, permanently
  // breaking the download - a revoke-on-cleanup + useMemo combination isn't
  // StrictMode-safe. The URL's lifetime is already bounded to the page
  // session (freed on reload/close); fine at this scale.
  // The sender picks mimeType: text/html or image/svg+xml in a blob: URL opened in a tab would run
  // as a page of this app's origin, where the keys are. Only raster images keep their type.
  const isImage = SAFE_IMAGE_TYPE.test(file.mimeType);
  const url = useMemo(() => URL.createObjectURL(new Blob([Uint8Array.from(file.bytes)], { type: isImage ? file.mimeType : "application/octet-stream" })), [message.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const selfDestructs = message.destructOnOpen || message.timerSeconds || message.expiresAt;

  return (
    <span data-testid="file-message" className="file-message">
      {isImage && <img src={url} alt={file.filename} className="file-preview" data-testid="file-preview" />}
      <span>
        {file.filename} <span className="meta">{formatSize(file.size)}</span>
        {selfDestructs && (
          <span data-testid="destruct-marker" className="meta">
            {" "}
            · deletes itself
          </span>
        )}
      </span>
      {message.direction === "sent" ? (
        <span data-testid="message-status" className="status">
          {message.status}
        </span>
      ) : (
        // Doesn't preventDefault - the native download still proceeds alongside the side effect.
        <a href={url} download={file.filename} data-testid="file-download" onClick={() => onOpenFile(message.id)}>
          Download
        </a>
      )}
    </span>
  );
}

/** The pairwise safety numbers, one per device of the contact, revealed group by group. */
function VerifyContact({ name, onLoadFingerprints, onDone }: { name: string; onLoadFingerprints: () => Promise<DeviceFingerprint[]>; onDone: () => void }) {
  const [fingerprints, setFingerprints] = useState<DeviceFingerprint[]>();
  useEffect(() => {
    onLoadFingerprints().then(setFingerprints, () => setFingerprints([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per opening

  return (
    <div className="page verify">
      <h2 className="title">Verify {name}</h2>
      <p className="hint">Compare this number with the one on {name}'s phone, in person or on a call, not in this chat. If every digit matches, nobody sits between you two.</p>
      {fingerprints?.length === 0 && <p className="hint">No secure session with this contact yet: send a message first.</p>}
      {fingerprints?.map((f) => {
        const groups = f.safetyNumber.split(" ");
        return (
          <div key={f.deviceId} className="field">
            <p className="label">{f.label}</p>
            <p className="number" data-testid="contact-fingerprint">
              {groups.map((g, i) => (
                <span key={i} style={{ "--i": i } as React.CSSProperties}>
                  {g}
                  {i < groups.length - 1 ? " " : ""}
                </span>
              ))}
            </p>
          </div>
        );
      })}
      <button onClick={onDone}>Done</button>
    </div>
  );
}

export function Conversation({
  contactId,
  messages,
  onSend,
  onSendFile,
  onOpenFile,
  onStartCall,
  onSetTimer,
  onTyping,
  onBack,
  onLoadFingerprints,
  onNicknameChange,
  onDelete,
  sending,
  fileStage,
  callActive,
  timerSeconds,
  error,
}: ConversationProps) {
  const [{ view, dir }, setNav] = useState<{ view: "chat" | "contact" | "verify"; dir?: "fwd" | "back" }>({ view: "chat" });
  const [nickname, setNickname] = useState<string>();
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [contactTyping, setContactTyping] = useState(false);
  const [fileSheet, setFileSheet] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [destructMode, setDestructMode] = useState("none");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Messages already there when the conversation opened stay still; only new ones land.
  const initialIds = useRef<Set<string>>(null);
  if (initialIds.current === null) initialIds.current = new Set(messages.map((m) => m.id));
  const listEnd = useRef<HTMLLIElement>(null);

  const name = nickname ?? contactId;

  useEffect(() => {
    loadNickname(contactId).then((n) => {
      setNickname(n);
      setNicknameDraft(n ?? "");
    });
  }, [contactId]);

  useEffect(() => {
    setContactTyping(false);
    const unsubscribe = subscribeToTypingState(setContactTyping);
    return () => {
      unsubscribe();
      resetTypingState();
    };
  }, [contactId]);

  useEffect(() => {
    if (view === "chat") listEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, contactTyping, view]);

  function go(next: "chat" | "contact" | "verify", direction: "fwd" | "back") {
    // Coming back to the chat must not replay the landing of messages that already landed.
    for (const m of messages) initialIds.current!.add(m.id);
    setNav({ view: next, dir: direction });
  }
  const enter = dir ? ` enter-${dir}` : "";

  async function commitNickname() {
    const next = nicknameDraft.trim();
    if (next === (nickname ?? "")) return;
    await saveNickname(contactId, next);
    setNickname(next || undefined);
    onNicknameChange();
    showToast(next ? `Shown as ${next}` : "Nickname removed");
  }

  function chooseTimer(seconds: number, label: string) {
    if (seconds === timerSeconds) return;
    onSetTimer(seconds);
    showToast(seconds ? `New messages disappear after ${label}` : "Messages no longer disappear");
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    setFileSheet(false);
    setFileError(undefined);
    // Images get re-encoded (and usually shrunk a lot) before the real size
    // check, inside sendFile - skip the early check here so a large-but-will-
    // compress-fine photo isn't rejected before it even gets the chance.
    if (!file.type.startsWith("image/") && isFileTooLarge(file)) {
      setFileError(`${file.name} is too large (max 8MB)`);
      return;
    }
    onSendFile(file, destructFromOption(destructMode));
    // Per-file opt-in, not a standing policy like the disappearing-message
    // timer - reset so the next file doesn't silently inherit this one's mode.
    setDestructMode("none");
  }

  if (view === "verify") {
    return (
      <main className={`screen-pane${enter}`} key="verify">
        <header className="bar">
          <button className="back" onClick={() => go("contact", "back")} aria-label="Back to contact settings">
            ‹ Back
          </button>
          <span />
          <span />
        </header>
        <VerifyContact name={name} onLoadFingerprints={onLoadFingerprints} onDone={() => go("contact", "back")} />
      </main>
    );
  }

  if (view === "contact") {
    return (
      <main className={`screen-pane${enter}`} key="contact">
        <header className="bar">
          <button className="back" onClick={() => go("chat", "back")} aria-label="Back to chat">
            ‹ Chat
          </button>
          <h1 className="bar-title">Contact settings</h1>
          <span />
        </header>
        <div className="page">
          <div className="contact-head">
            <span className="avatar big" aria-hidden>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <h2 className="title">{name}</h2>
            {nickname && <p className="chip">{contactId}</p>}
          </div>
          <div className="settings-list">
            <label className="setting">
              <span>
                Nickname
                <small>Only you see it</small>
              </span>
              <input
                aria-label="Nickname"
                placeholder="None"
                value={nicknameDraft}
                onChange={(e) => setNicknameDraft(e.target.value)}
                onBlur={() => void commitNickname()}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                autoComplete="off"
              />
            </label>
            <div className="setting stacked">
              <span>
                Disappearing messages
                <small>New messages delete themselves this long after they are read</small>
              </span>
              <div className="pills" role="radiogroup" aria-label="Disappearing message timer" data-testid="timer-picker">
                {TIMER_OPTIONS.map(([seconds, label]) => (
                  <button key={seconds} className="pill" role="radio" aria-checked={timerSeconds === seconds} onClick={() => chooseTimer(seconds, label)} disabled={sending}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <button className="setting" onClick={() => go("verify", "fwd")}>
              <span>
                Verify safety number
                <small>Check nobody sits between you two</small>
              </span>
              <span className="chevron" aria-hidden>
                ›
              </span>
            </button>
            <button className="setting danger-text" onClick={() => setConfirmDelete(true)}>
              <span>
                Delete chat
                <small>Removes the messages from this device only</small>
              </span>
            </button>
          </div>
        </div>
        <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} label="Delete chat">
          <h2 className="title">Delete this chat?</h2>
          <p className="hint">Every message in it is removed from this device, files included. Your contact keeps their copy and can still write to you.</p>
          <button
            className="danger"
            onClick={() => {
              // Closed first: an open modal leaves the next screen inert.
              setConfirmDelete(false);
              onDelete();
            }}
          >
            Delete chat
          </button>
          <button className="secondary" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </Sheet>
      </main>
    );
  }

  return (
    <main className={`screen-pane convo${enter}`} key="chat">
      <header className="bar">
        <button className="back" onClick={onBack} aria-label="Back to menu">
          ‹ Chats
        </button>
        <h1 className="bar-title" data-testid="conversation-title">
          {name}
        </h1>
        <div className="bar-actions">
          <button className="icon" onClick={() => onStartCall("voice")} disabled={callActive} aria-label="Voice call">
            <PhoneIcon />
          </button>
          <button className="icon" onClick={() => onStartCall("video")} disabled={callActive} aria-label="Video call">
            <VideoIcon />
          </button>
          <button className="icon" onClick={() => go("contact", "fwd")} aria-label="Contact settings">
            <MoreIcon />
          </button>
        </div>
      </header>

      <p role="note" className="disclosure" data-testid="screenshot-disclosure">
        Screenshots can't be detected on the web: anything shown here can be captured.
      </p>

      <ul className="messages" data-testid="message-list">
        {messages.length === 0 && <li className="messages-empty">No messages yet. Say hi.</li>}
        {messages.map((m) => (
          <li key={m.id} data-testid={`message-${m.direction}`} className={`bubble ${m.direction}${initialIds.current!.has(m.id) ? "" : " land"}`}>
            {m.file ? <FileMessage message={m} onOpenFile={onOpenFile} /> : <span>{m.text}</span>}
            {!m.file && (m.timerSeconds || m.expiresAt) && (
              <span data-testid="disappearing-marker" className="meta" title="Disappears">
                {" "}
                ⏱
              </span>
            )}
            {m.direction === "sent" && !m.file && (
              <span data-testid="message-status" className="status">
                {m.status}
              </span>
            )}
          </li>
        ))}
        {contactTyping && (
          <li className="typing" data-testid="typing-indicator">
            <span className="visually-hidden">{name} is typing…</span>
            <i />
            <i />
            <i />
          </li>
        )}
        <li ref={listEnd} className="list-end" aria-hidden />
      </ul>

      {fileStage && fileStage !== "sent" && (
        <p className="hint progress" data-testid="file-stage">
          {fileStage}...
        </p>
      )}
      {fileError && <p role="alert">{fileError}</p>}
      {error && <p role="alert">{error}</p>}

      <Composer onSend={onSend} onTyping={onTyping} onAttach={() => setFileSheet(true)} sending={sending} />

      <Sheet open={fileSheet} onClose={() => setFileSheet(false)} label="Send a file">
        <h2 className="title">Send a file</h2>
        <p className="hint">Delete it on {name}'s side:</p>
        <div className="pills" role="radiogroup" aria-label="Self-destruct mode for the next file" data-testid="file-destruct-mode">
          {DESTRUCT_OPTIONS.map(([value, label]) => (
            <button key={value} className="pill" role="radio" aria-checked={destructMode === value} onClick={() => setDestructMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {/* The input lives in the sheet so the picker opens from inside the modal; tests set files on it directly. */}
        <label className="button-like">
          Choose a file
          <input type="file" className="visually-hidden" aria-label="Attach a file" onChange={handleFilePick} disabled={sending} />
        </label>
      </Sheet>
    </main>
  );
}
