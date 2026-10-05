import { useState } from "react";
import { PlusIcon, SendIcon } from "./icons";

interface ComposerProps {
  onSend: (text: string) => void;
  onTyping?: () => void;
  /** Shows the "+" button for files. */
  onAttach?: () => void;
  sending: boolean;
}

export function Composer({ onSend, onTyping, onAttach, sending }: ComposerProps) {
  const [text, setText] = useState("");

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {onAttach && (
        <button type="button" className="round quiet" onClick={onAttach} aria-label="Send a file" disabled={sending}>
          <PlusIcon />
        </button>
      )}
      <input
        type="text"
        placeholder="Type a message..."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onTyping?.();
        }}
        disabled={sending}
        autoComplete="off"
      />
      <button type="submit" className="round" aria-label="Send" disabled={sending || !text.trim()}>
        <SendIcon />
      </button>
    </form>
  );
}
