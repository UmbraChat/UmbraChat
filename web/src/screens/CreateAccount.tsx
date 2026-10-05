import { useState } from "react";
import { Logo } from "./icons";
import { DISTRIBUTION, SERVER_URL_REQUIRED, getStoredServerUrl, setServerUrl } from "../api/server";

const RELEASES_URL = "https://github.com/UmbraChat/UmbraChat/releases";

interface CreateAccountProps {
  onCreate: () => void;
  onLink: (accountId: string, code: string) => void;
  onRestore: (file: File, passphrase: string) => void;
  creating: boolean;
  error?: string;
  /** Set while this device waits to be accepted by another one of the account. */
  linkFingerprint?: string;
  onCancelLink: () => void;
}

export function CreateAccount({ onCreate, onLink, onRestore, creating, error, linkFingerprint, onCancelLink }: CreateAccountProps) {
  const [linkAccountId, setLinkAccountId] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [backupFile, setBackupFile] = useState<File>();
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [server, setServer] = useState(getStoredServerUrl());
  const [serverError, setServerError] = useState<string>();

  // Saves the server entered above before any request is made; false (with a message) if it is unusable.
  // An instance's own page only ever talks to its own server: its policy blocks any other.
  function applyServer(): boolean {
    if (!SERVER_URL_REQUIRED) return true;
    setServerError(undefined);
    try {
      setServerUrl(server);
      return true;
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "invalid server address");
      return false;
    }
  }
  const serverMissing = SERVER_URL_REQUIRED && !server.trim();

  if (linkFingerprint) {
    return (
      <main className="screen">
        <div className="panel stack">
          <h2>Waiting for your other device</h2>
          <p className="hint">
            On a device already in this account, open Linked Devices, check that this number is the same there, then accept. If it differs, cancel: someone else is trying to join.
          </p>
          <p className="chip chip--block" data-testid="link-fingerprint">
            {linkFingerprint}
          </p>
          <button className="secondary" onClick={onCancelLink}>
            Cancel
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="brand">
        <Logo />
        <h1>UmbraChat</h1>
        <p>No password. Your keys never leave this device.</p>
      </div>

      {DISTRIBUTION === "hosted" && (
        <div className="panel stack" data-testid="hosted-notice">
          <h2>This page is served by {window.location.host}</h2>
          <p className="hint">It holds no account and no messages, but whoever controls {window.location.host} could change the app you load here.</p>
          <a href={RELEASES_URL}>Install UmbraChat on your device instead</a>
        </div>
      )}

      {SERVER_URL_REQUIRED && (
        <div className="panel stack">
          <h2>Server</h2>
          <p className="hint">Enter the address of your server. It relays your messages and sees who talks to whom, never what is said.</p>
          <input placeholder="https://chat.example.org" aria-label="Server address" data-testid="server-input" value={server} onChange={(e) => setServer(e.target.value)} disabled={creating} />
          {serverError && (
            <p role="alert" data-testid="server-error">
              {serverError}
            </p>
          )}
        </div>
      )}

      <div className="panel stack">
        <button onClick={() => applyServer() && onCreate()} disabled={creating || serverMissing}>
          {creating ? "Creating..." : "Create Account"}
        </button>
        {!SERVER_URL_REQUIRED && (
          <p className="hint server-line" data-testid="instance-server">
            Your account will live on this site's server, {window.location.host}. For another server, <a href={RELEASES_URL}>install UmbraChat on your device</a>: its code then comes from you, not from that server's host.
          </p>
        )}
      </div>

      {/* Rare paths: folded so the first screen fits without scrolling. */}
      <details className="panel more">
        <summary>Already have an account?</summary>
        <div className="stack">
          <p className="hint">Enter its account ID, and the pairing code shown by one of its devices.</p>
          <input placeholder="Account ID" value={linkAccountId} onChange={(e) => setLinkAccountId(e.target.value)} disabled={creating} />
          <input placeholder="Pairing code" value={linkCode} onChange={(e) => setLinkCode(e.target.value)} disabled={creating} />
          <button className="secondary" onClick={() => applyServer() && onLink(linkAccountId, linkCode)} disabled={creating || serverMissing || !linkAccountId.trim() || !linkCode.trim()}>
            Link This Device
          </button>
        </div>
      </details>

      <details className="panel more">
        <summary>Lost your device?</summary>
        <div className="stack">
          <input type="file" accept=".json" aria-label="Backup file" onChange={(e) => setBackupFile(e.target.files?.[0])} disabled={creating} />
          <input type="password" placeholder="Backup passphrase" value={backupPassphrase} onChange={(e) => setBackupPassphrase(e.target.value)} disabled={creating} />
          <button
            className="secondary"
            onClick={() => backupFile && (server.trim() ? applyServer() : true) && onRestore(backupFile, backupPassphrase)}
            disabled={creating || serverMissing || !backupFile || !backupPassphrase}
          >
            {creating ? "Restoring..." : "Restore from Backup"}
          </button>
        </div>
      </details>

      {error && <p role="alert">{error}</p>}
    </main>
  );
}
