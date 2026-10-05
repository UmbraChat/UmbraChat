import { useState } from "react";

interface UnlockProps {
  onUnlock: (passphrase: string) => Promise<boolean>;
  /** Present when this device registered a security key or its own lock for unlocking. */
  onUnlockWithKey?: () => Promise<boolean>;
}

export function Unlock({ onUnlock, onUnlockWithKey }: UnlockProps) {
  const [passphrase, setPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit() {
    setWorking(true);
    setError(undefined);
    try {
      const ok = await onUnlock(passphrase);
      if (!ok) {
        setError("Wrong passphrase. Try again.");
        setPassphrase("");
      }
    } finally {
      setWorking(false);
    }
  }

  async function handleKey() {
    if (!onUnlockWithKey) return;
    setWorking(true);
    setError(undefined);
    try {
      if (!(await onUnlockWithKey())) setError("That security key does not open this app. Use your passphrase.");
    } catch (err) {
      setError(`Security key unlock failed (${err instanceof Error ? err.message : "cancelled"}). Use your passphrase.`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="screen">
      <h1>UmbraChat — Locked</h1>
      <section className="panel stack">
        <input
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          disabled={working}
          autoFocus
        />
        <button onClick={handleSubmit} disabled={working || !passphrase}>
          {working ? "Unlocking..." : "Unlock"}
        </button>
        {onUnlockWithKey && (
          <button className="secondary" onClick={handleKey} disabled={working}>
            Unlock with security key
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
