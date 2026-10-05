import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatEntry } from "./useChatList";
import { Sheet } from "./Sheet";

interface ChatListProps {
  entries: ChatEntry[];
  activeId?: string;
  ownAccountId: string;
  onOpen: (entry: ChatEntry) => void;
  /** Resolves true once the conversation is open. */
  onStart: (contactIdOrInvite: string) => Promise<boolean>;
  onCreateGroup: (name: string, memberAccountIds: string[]) => Promise<boolean>;
  busy: boolean;
  error?: string;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - date.getTime() < 6 * 24 * 3600 * 1000) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ChatList({ entries, activeId, ownAccountId, onOpen, onStart, onCreateGroup, busy, error }: ChatListProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "group">("chat");
  const [contact, setContact] = useState("");
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState("");
  // A modal sheet makes the page behind it inert: close it the moment a chat shows, not once
  // everything opening it does (read receipts) is over.
  useEffect(() => setSheetOpen(false), [activeId]);

  // When a conversation jumps to the top, every row slides from where it was to where it is now.
  const rows = useRef(new Map<string, HTMLElement>());
  const lastTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    for (const [id, el] of rows.current) tops.set(id, el.offsetTop);
    if (!reducedMotion()) {
      for (const [id, top] of tops) {
        const before = lastTops.current.get(id);
        if (before !== undefined && before !== top) {
          rows.current.get(id)?.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.2, .8, .2, 1)" });
        }
      }
    }
    lastTops.current = tops;
  });

  async function handleStart() {
    if (await onStart(contact.trim())) {
      setContact("");
      setSheetOpen(false);
    }
  }

  async function handleCreateGroup() {
    // createGroup already adds the caller to the roster: a self id here would duplicate it.
    const memberAccountIds = members
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id && id !== ownAccountId);
    if (await onCreateGroup(groupName.trim(), memberAccountIds)) {
      setGroupName("");
      setMembers("");
      setSheetOpen(false);
    }
  }

  return (
    <section className="chat-list" aria-label="Chats">
      <header className="list-head">
        <h1>Chats</h1>
        <button className="secondary pill-button" data-testid="new-chat" onClick={() => setSheetOpen(true)}>
          New chat
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="list-empty">No chats yet. Start one with New chat, or share your invite from Me.</p>
      ) : (
        <ul className="rows">
          {entries.map((entry) => (
            <li
              key={entry.id}
              ref={(el) => {
                if (el) rows.current.set(entry.id, el);
                else rows.current.delete(entry.id);
              }}
            >
              <button
                className={`chat-row${entry.unread ? " unread" : ""}`}
                aria-current={entry.id === activeId ? "true" : undefined}
                data-testid={entry.kind === "group" ? "group-row" : entry.unread ? "incoming-chat-row" : "chat-row"}
                onClick={() => onOpen(entry)}
              >
                <span className="avatar" aria-hidden>
                  {entry.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="who">
                  <span className="name">{entry.name}</span>
                  <span className="preview">{entry.preview}</span>
                </span>
                <span className="when">
                  {formatWhen(entry.at)}
                  {entry.unread && <span className="dot" aria-label="unread" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} label="New chat">
        <div className="segmented" role="tablist" aria-label="What to start">
          <button role="tab" aria-selected={mode === "chat"} onClick={() => setMode("chat")}>
            Chat
          </button>
          <button role="tab" aria-selected={mode === "group"} onClick={() => setMode("group")}>
            New group
          </button>
        </div>
        {mode === "chat" ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void handleStart();
            }}
          >
            <input placeholder="Invite or account id" aria-label="Invite or account id" value={contact} onChange={(e) => setContact(e.target.value)} disabled={busy} autoComplete="off" />
            <p className="hint">Paste the invite your contact gave you: it proves the account is theirs, which a bare account id cannot.</p>
            <button type="submit" disabled={busy || !contact.trim()}>
              {busy ? "Starting..." : "Start chat"}
            </button>
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateGroup();
            }}
          >
            <input placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} disabled={busy} autoComplete="off" />
            <input placeholder="Member account IDs, comma-separated" value={members} onChange={(e) => setMembers(e.target.value)} disabled={busy} autoComplete="off" />
            <button type="submit" disabled={busy || !groupName.trim() || !members.trim()}>
              Create Group
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </Sheet>
    </section>
  );
}
