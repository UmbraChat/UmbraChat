import { useState } from "react";

interface SafetyNumberProps {
  accountId: string;
  safetyNumber: string;
  onContinue?: () => void;
  /** Builds this account's invite; shown so it can be copied. */
  onGetInvite?: () => Promise<string>;
}

export function SafetyNumber({ accountId, safetyNumber, onContinue, onGetInvite }: SafetyNumberProps) {
  const [invite, setInvite] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <section className="panel stack">
      <h2>Your Identity</h2>
      <div>
        <p className="hint">Key fingerprint of this device - read it out (in person or on a call) when a contact asks to check a new device of yours.</p>
        <p className="chip chip--block" data-testid="safety-number">
          {safetyNumber}
        </p>
      </div>
      <div>
        <p className="hint">Account ID - share this so contacts can message you.</p>
        <p className="chip chip--block" data-testid="account-id">
          {accountId}
        </p>
      </div>
      {onGetInvite && (
        <div>
          <p className="hint">Invite - give this to a contact over a channel you trust (in person, a call): it lets their app check that it is really you, not whatever the server says.</p>
          {invite ? (
            <p className="chip chip--block" data-testid="invite">
              {invite}
            </p>
          ) : (
            <button
              className="secondary"
              onClick={() => onGetInvite().then(setInvite, (err) => setError(err instanceof Error ? err.message : "could not build the invite"))}
            >
              Show my invite
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {onContinue && <button onClick={onContinue}>Continue</button>}
    </section>
  );
}
