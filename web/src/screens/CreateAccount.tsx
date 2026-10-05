import { useState } from "react";
import { SERVER_URL_REQUIRED, getStoredServerUrl, setServerUrl } from "../api/server";

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
  function applyServer(): boolean {
    setServerError(undefined);
    if (!server.trim() && !SERVER_URL_REQUIRED) return true; // keep the default: this site's own API
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
      <main className="stack">
        <div className="panel stack">
          <h2>Waiting for your other device</h2>
          <p className="hint">On a device already in this account, open Linked Devices, check that this number is the same there, then accept. If it differs, cancel: someone else is trying to join.</p>
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
      <div className="stack" style={{ textAlign: "center" }}>
        <h1>UmbraChat</h1>
        <p>No password. Your keys never leave this device.</p>
      </div>

      <div className="panel stack">
        <h2>Server</h2>
        <p className="hint">
          {SERVER_URL_REQUIRED
            ? "Messages are relayed by a server you choose. It sees who talks to whom, never what is said."
            : "Leave empty to use the server this page comes from."}
        </p>
        <input
          placeholder="https://chat.example.org"
          aria-label="Server address"
          data-testid="server-input"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          disabled={creating}
        />
        {serverError && (
          <p role="alert" data-testid="server-error">
            {serverError}
          </p>
        )}
      </div>

      <div className="panel stack">
        <button onClick={() => applyServer() && onCreate()} disabled={creating || serverMissing}>
          {creating ? "Creating..." : "Create Account"}
        </button>
      </div>

      <div className="panel stack">
        <h2>Already have an account?</h2>
        <p className="hint">Enter its account ID and pairing code below.</p>
        <input placeholder="Account ID" value={linkAccountId} onChange={(e) => setLinkAccountId(e.target.value)} disabled={creating} />
        <input placeholder="Pairing code" value={linkCode} onChange={(e) => setLinkCode(e.target.value)} disabled={creating} />
        <button className="secondary" onClick={() => applyServer() && onLink(linkAccountId, linkCode)}
          disabled={creating || serverMissing || !linkAccountId.trim() || !linkCode.trim()}>
          Link This Device
        </button>
      </div>

      <div className="panel stack">
        <h2>Lost your device?</h2>
        <input
          type="file"
          accept=".json"
          aria-label="Backup file"
          onChange={(e) => setBackupFile(e.target.files?.[0])}
          disabled={creating}
        />
        <input
          type="password"
          placeholder="Backup passphrase"
          value={backupPassphrase}
          onChange={(e) => setBackupPassphrase(e.target.value)}
          disabled={creating}
        />
        <button
          className="secondary"
          onClick={() => backupFile && (server.trim() ? applyServer() : true) && onRestore(backupFile, backupPassphrase)}
          disabled={creating || serverMissing || !backupFile || !backupPassphrase}
        >
          {creating ? "Restoring..." : "Restore from Backup"}
        </button>
      </div>

      {error && <p role="alert">{error}</p>}
    </main>
  );
}
