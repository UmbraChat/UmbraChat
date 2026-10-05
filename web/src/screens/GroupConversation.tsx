import { useEffect, useRef, useState } from "react";
import type { Group } from "../chat/group";
import type { ChatMessage } from "../storage/messageStore";
import type { LocalAccount } from "../storage/keyStore";
import { Composer } from "./Composer";
import { MoreIcon } from "./icons";

interface GroupConversationProps {
  group: Group;
  account: LocalAccount;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onRemoveMember: (memberAccountId: string) => void;
  onBack: () => void;
  sending: boolean;
  error?: string;
}

export function GroupConversation({ group, account, messages, onSend, onRemoveMember, onBack, sending, error }: GroupConversationProps) {
  const [{ view, dir }, setNav] = useState<{ view: "chat" | "members"; dir?: "fwd" | "back" }>({ view: "chat" });
  // Messages already there when the group opened stay still; only new ones land.
  const initialIds = useRef<Set<string>>(null);
  if (initialIds.current === null) initialIds.current = new Set(messages.map((m) => m.id));
  const listEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (view === "chat") listEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, view]);

  function go(next: "chat" | "members", direction: "fwd" | "back") {
    for (const m of messages) initialIds.current!.add(m.id);
    setNav({ view: next, dir: direction });
  }
  const enter = dir ? ` enter-${dir}` : "";

  if (view === "members") {
    return (
      <main className={`screen-pane${enter}`} key="members">
        <header className="bar">
          <button className="back" onClick={() => go("chat", "back")} aria-label="Back to chat">
            ‹ Chat
          </button>
          <h1 className="bar-title">Group settings</h1>
          <span />
        </header>
        <div className="page">
          <div className="contact-head">
            <span className="avatar big" aria-hidden>
              {group.name.slice(0, 1).toUpperCase()}
            </span>
            <h2 className="title">{group.name}</h2>
          </div>
          <section className="panel stack">
            <h2>Members</h2>
            <ul className="settings-list" data-testid="group-member-list">
              {group.memberAccountIds.map((id) => (
                <li key={id} className="setting" data-testid="group-member">
                  <span className="chip">{id}</span>
                  {id !== account.accountId && (
                    <button className="danger" onClick={() => onRemoveMember(id)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="hint">A removed member stops receiving new messages; what they already received stays with them.</p>
          </section>
          {error && <p role="alert">{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className={`screen-pane convo${enter}`} key="chat">
      <header className="bar">
        <button className="back" onClick={onBack} aria-label="Back to menu">
          ‹ Chats
        </button>
        <h1 className="bar-title">{group.name}</h1>
        <div className="bar-actions">
          <button className="icon" onClick={() => go("members", "fwd")} aria-label="Group settings">
            <MoreIcon />
          </button>
        </div>
      </header>

      <ul className="messages" data-testid="group-message-list">
        {messages.length === 0 && <li className="messages-empty">No messages yet. Say hi.</li>}
        {messages.map((m) => (
          <li key={m.id} data-testid="group-message" className={`bubble ${m.direction}${initialIds.current!.has(m.id) ? "" : " land"}`}>
            {m.direction === "received" ? <span className="sender">{m.senderAccountId}: </span> : null}
            {m.text}
          </li>
        ))}
        <li ref={listEnd} className="list-end" aria-hidden />
      </ul>

      {error && <p role="alert">{error}</p>}
      <Composer onSend={onSend} sending={sending} />
    </main>
  );
}
