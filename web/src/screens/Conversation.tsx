import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../storage/messageStore";
import { isFileTooLarge, subscribeToTypingState, resetTypingState, type FileDestruct, type FileSendStage } from "../chat/conversation";
import type { DeviceFingerprint } from "../crypto/trust";
import { loadNickname, saveNickname } from "../storage/nicknameStore";

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
  ["none", "None"],
  ["on-open", "Delete after opening"],
  ["30", "Delete after 30s"],
  ["300", "Delete after 5m"],
  ["3600", "Delete after 1h"],
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
    <span data-testid="file-message">
      {isImage && <img src={url} alt={file.filename} className="file-preview" data-testid="file-preview" />}
      📎 {file.filename} ({formatSize(file.size)}){selfDestructs && <span data-testid="destruct-marker"> 🔥</span>}
      {message.direction === "sent" ? (
        <span data-testid="message-status"> ({message.status})</span>
      ) : (
        // Doesn't preventDefault - the native download still proceeds alongside the side effect.
        <a href={url} download={file.filename} data-testid="file-download" onClick={() => onOpenFile(message.id)}>
          Download
        </a>
      )}
    </span>
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
  sending,
  fileStage,
  callActive,
  timerSeconds,
  error,
}: ConversationProps) {
  const [text, setText] = useState("");
  const [fingerprints, setFingerprints] = useState<DeviceFingerprint[]>();
  const [fileError, setFileError] = useState<string>();
  const [destructMode, setDestructMode] = useState("none");
  const [nickname, setNickname] = useState<string>();
  const [contactTyping, setContactTyping] = useState(false);

  useEffect(() => {
    loadNickname(contactId).then(setNickname);
  }, [contactId]);

  useEffect(() => {
    setContactTyping(false);
    const unsubscribe = subscribeToTypingState(setContactTyping);
    return () => {
      unsubscribe();
      resetTypingState();
    };
  }, [contactId]);

  async function handleEditNickname() {
    const next = window.prompt("Nickname for this contact (empty to clear)", nickname ?? "");
    if (next === null) return;
    await saveNickname(contactId, next);
    setNickname(next.trim() || undefined);
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
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

  return (
    <main className="convo screen screen--wide">
      <div className="convo-toolbar">
        <button className="secondary" onClick={onBack} aria-label="Back to menu">
          ← Menu
        </button>
        <h1 data-testid="conversation-title">{nickname ?? contactId}</h1>
        <button className="icon" onClick={handleEditNickname} aria-label="Edit nickname">
          ✎
        </button>
        <span className="spacer" />
        <button className="icon" onClick={() => onStartCall("voice")} disabled={callActive} aria-label="Voice call">
          📞
        </button>
        <button className="icon" onClick={() => onStartCall("video")} disabled={callActive} aria-label="Video call">
          🎥
        </button>
        <label className="row">
          ⏱
          <select
            data-testid="timer-picker"
            aria-label="Disappearing message timer"
            value={timerSeconds}
            onChange={(e) => onSetTimer(Number(e.target.value))}
            disabled={sending}
          >
            {TIMER_OPTIONS.map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details
        className="hint"
        onToggle={(e) => {
          if (e.currentTarget.open) onLoadFingerprints().then(setFingerprints).catch(() => setFingerprints([]));
        }}
      >
        <summary>Verify this contact</summary>
        <p>Safety number of this conversation: you and your contact must see exactly the same number. Compare in person or on a call, not in this chat.</p>
        {fingerprints?.length === 0 && <p>No secure session with this contact yet: send a message first.</p>}
        {fingerprints?.map((f) => (
          <p key={f.deviceId}>
            {f.label}
            <span className="chip chip--block" data-testid="contact-fingerprint">
              {f.safetyNumber}
            </span>
          </p>
        ))}
      </details>

      {contactTyping && (
        <p className="hint" data-testid="typing-indicator">
          {nickname ?? contactId} is typing…
        </p>
      )}

      <p role="note" className="disclosure" data-testid="screenshot-disclosure">
        ⚠ Screenshots can't be detected on web - assume anything shown here can be captured.
      </p>

      <ul className="message-list" data-testid="message-list">
        {messages.length === 0 && <li className="message-list-empty">No messages yet - say hi.</li>}
        {messages.map((m) => (
          <li key={m.id} data-testid={`message-${m.direction}`}>
            {m.file ? <FileMessage message={m} onOpenFile={onOpenFile} /> : <span>{m.text}</span>}
            {!m.file && (m.timerSeconds || m.expiresAt) && <span data-testid="disappearing-marker"> ⏱</span>}
            {m.direction === "sent" && !m.file && <span data-testid="message-status"> ({m.status})</span>}
          </li>
        ))}
      </ul>

      <div className="stack">
        <div className="composer">
          <input
            type="text"
            placeholder="Type a message..."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onTyping();
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={sending}
          />
          <button onClick={handleSend} disabled={sending || !text.trim()}>
            Send
          </button>
        </div>
        <div className="file-row">
          <input type="file" aria-label="Attach a file" onChange={handleFilePick} disabled={sending} />
          <select
            data-testid="file-destruct-mode"
            aria-label="Self-destruct mode for the next file"
            value={destructMode}
            onChange={(e) => setDestructMode(e.target.value)}
            disabled={sending}
          >
            {DESTRUCT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {fileStage && fileStage !== "sent" && (
        <p className="hint" data-testid="file-stage">
          {fileStage}...
        </p>
      )}
      {fileError && <p role="alert">{fileError}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
