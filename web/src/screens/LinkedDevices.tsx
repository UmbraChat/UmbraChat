import { useEffect, useState } from "react";
import type { LocalAccount } from "../storage/keyStore";
import { listDevices, linkInit } from "../api/devices";
import { listPendingDevices, type PendingDevice } from "../api/chain";
import { verifiedChain } from "../crypto/chains";
import { acceptDevice, removeDevice } from "../crypto/deviceActions";
import { computeSafetyNumber } from "../crypto/identity";

const REFRESH_INTERVAL_MS = 3000;

interface LinkedDevicesProps {
  account: LocalAccount;
}

interface Row {
  id: string;
  label: string;
}

interface PendingRow extends PendingDevice {
  fingerprint: string;
}

export function LinkedDevices({ account }: LinkedDevicesProps) {
  const [devices, setDevices] = useState<Row[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();

  async function refresh() {
    try {
      // The list shown is the signed one; the server only supplies the names.
      const chain = await verifiedChain(account.accountId, account);
      const labels = new Map((await listDevices(account.accountId, account)).map((d) => [d.id, d.label]));
      setDevices(chain.devices.map((d) => ({ id: d.deviceId, label: labels.get(d.deviceId) ?? d.deviceId.slice(0, 8) })));
      const waiting = await listPendingDevices(account);
      setPending(await Promise.all(waiting.map(async (p) => ({ ...p, fingerprint: await computeSafetyNumber(Array.from(p.identityKey)) }))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load devices");
    }
  }

  useEffect(() => {
    void refresh();
    // A device linked from elsewhere has no way to notify this screen directly -
    // same eventual-consistency-via-polling approach the message pipe already uses.
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.accountId]);

  async function run(action: () => Promise<void>, failure: string) {
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    }
  }

  async function handleLinkInit() {
    setError(undefined);
    try {
      setCode(await linkInit(account));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start device link");
    }
  }

  return (
    <section className="panel stack">
      <h2>Linked Devices</h2>
      <ul data-testid="device-list">
        {devices.length === 0 && <li className="list-empty">No devices yet.</li>}
        {devices.map((d) => (
          <li key={d.id} className="list-row" data-testid="device-row">
            <span className="list-row-label">
              {d.label}
              {d.id === account.deviceId && " (this device)"}
            </span>
            {d.id !== account.deviceId && (
              <button className="secondary" onClick={() => run(() => removeDevice(account, d.id), "failed to unlink device")}>
                Unlink
              </button>
            )}
          </li>
        ))}
      </ul>
      {pending.map((p) => (
        <div key={p.id} className="stack" data-testid="pending-device">
          <p className="hint">
            A new device ({p.label}) wants to join. Check that the numbers below are the same as the ones shown on that device, then accept. If they differ, do not accept: someone else is trying to join.
          </p>
          <p className="chip chip--block" data-testid="pending-fingerprint">
            {p.fingerprint}
          </p>
          <button onClick={() => run(() => acceptDevice(account, p), "failed to accept the device")} data-testid="accept-device">
            Numbers match, accept
          </button>
        </div>
      ))}
      <button className="secondary" onClick={handleLinkInit}>
        Link a New Device
      </button>
      {code && (
        <div className="stack">
          <p className="hint">
            On the new device, choose "Link to existing account" and enter this account ID and code - expires in 5 minutes. Then accept the device here once the numbers match.
          </p>
          <p className="chip chip--block">{account.accountId}</p>
          <p className="chip chip--block" data-testid="link-code">
            {code}
          </p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
