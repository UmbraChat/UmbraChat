import { useState } from "react";

interface NewConversationProps {
  onStart: (contactId: string) => void;
  starting: boolean;
  error?: string;
}

export function NewConversation({ onStart, starting, error }: NewConversationProps) {
  const [contactId, setContactId] = useState("");

  return (
    <section className="panel stack">
      <h2>New Conversation</h2>
      <input
        type="text"
        placeholder="Recipient account id"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
        disabled={starting}
      />
      <p className="hint">Or paste the invite your contact gave you: it authenticates them, which a plain id cannot.</p>
      <button onClick={() => onStart(contactId.trim())} disabled={starting || !contactId.trim()}>
        {starting ? "Starting..." : "Start Conversation"}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
