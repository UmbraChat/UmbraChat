import { useState } from "react";
import { showToast } from "./Toast";

interface SafetyNumberProps {
  accountId: string;
  safetyNumber: string;
  /** Builds this account's invite; copied on request and shown. */
  onGetInvite: () => Promise<string>;
}

export function SafetyNumber({ accountId, safetyNumber, onGetInvite }: SafetyNumberProps) {
  const [invite, setInvite] = useState<string>();
  const [error, setError] = useState<string>();

  // Copies on an explicit click only, and shows the invite too in case the copy fails.
  async function copyInvite() {
    setError(undefined);
    let text: string;
    try {
      text = invite ?? (await onGetInvite());
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not build the invite");
      return;
    }
    setInvite(text);
    try {
      await navigator.clipboard.writeText(text);
      showToast("Invite copied");
    } catch {
      showToast("Could not copy: select the invite above");
    }
  }

  return (
    <section className="panel stack">
      <h2>Your identity</h2>
      <div className="field">
        <p className="label">Invite</p>
        <p className="hint">Give it to a contact over a channel you trust (in person, a call). Their app then checks that it is really you, not whatever the server says.</p>
        {invite && (
          <p className="chip chip--block" data-testid="invite">
            {invite}
          </p>
        )}
        <button className="secondary" onClick={() => void copyInvite()}>
          Copy my invite
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="field">
        <p className="label">Account ID</p>
        <p className="chip chip--block" data-testid="account-id">
          {accountId}
        </p>
      </div>
      <div className="field">
        <p className="label">Key fingerprint of this device</p>
        <p className="hint">Read it out when a contact asks to check a new device of yours.</p>
        <p className="chip chip--block" data-testid="safety-number">
          {safetyNumber}
        </p>
      </div>
    </section>
  );
}
