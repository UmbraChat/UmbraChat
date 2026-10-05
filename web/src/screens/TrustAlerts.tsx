import type { TrustAlert } from "../crypto/trust";

interface TrustAlertsProps {
  alerts: TrustAlert[];
  onDismiss: (id: string) => void;
}

const TITLES: Record<TrustAlert["reason"], string> = {
  "unlisted-device": "Unknown device refused",
  "key-mismatch": "Device key does not match the signed list",
  "key-changed": "Security key changed",
  "chain-withheld": "Server withheld a device list update",
  "chain-forked": "Server showed a different device list",
};

const TEXTS: Record<TrustAlert["reason"], (contact: string) => string> = {
  "unlisted-device": (c) => `A device that is not in ${c}'s signed device list tried to message you. It was refused and its message dropped. A legitimate device is always in that list: this is either a broken server or an attack.`,
  "key-mismatch": (c) => `A device of ${c} presented a key other than the one in their signed device list. It was refused.`,
  "key-changed": (c) => `A device of ${c} now uses a different security key than the one you first saw. It was refused.`,
  "chain-withheld": (c) => `${c}'s own messages refer to a newer version of their device list than the server will give you. The server is holding something back, possibly the removal of a stolen device. Be careful what you send, and check with ${c} another way.`,
  "chain-forked": (c) => `${c} and the server disagree about the current version of their device list. Check with ${c} another way before trusting this conversation.`,
};

export function TrustAlerts({ alerts, onDismiss }: TrustAlertsProps) {
  if (alerts.length === 0) return null;
  return (
    <section className="trust-alerts" aria-label="Security alerts" data-testid="trust-alerts">
      {alerts.map((a) => (
        <div key={a.id} className="panel stack" data-testid="trust-alert" data-reason={a.reason}>
          <strong>{TITLES[a.reason]}</strong>
          <p className="hint">{TEXTS[a.reason](a.contactId)}</p>
          {a.fingerprint && (
            <p className="chip chip--block" data-testid="trust-alert-fingerprint">
              {a.fingerprint}
            </p>
          )}
          <div className="row">
            <button className="secondary" onClick={() => onDismiss(a.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
