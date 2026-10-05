import { useEffect, useState } from "react";
import { isEncryptionEnabled, enableEncryption, disableEncryption, isKeyUnlockEnabled, isKeyUnlockSupported, enableKeyUnlock, disableKeyUnlock } from "../crypto/vault";
import { exportBackup } from "../crypto/backup";
import { registerPushSubscription, unregisterPushSubscription, fetchPushPublicKey, vapidPublicKeyToUint8Array } from "../api/push";
import { getServerUrl, isSameHostAsServer } from "../api/server";
import {
  loadPushDisplayLevel,
  savePushDisplayLevel,
  loadTypingIndicatorEnabled,
  saveTypingIndicatorEnabled,
  type PushDisplayLevel,
} from "../storage/pushPrefsStore";
import type { LocalAccount } from "../storage/keyStore";

interface SettingsProps {
  account: LocalAccount;
  onBack: () => void;
}

const MIN_PASSPHRASE_LENGTH = 8;

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Settings({ account, onBack }: SettingsProps) {
  const [enabled, setEnabled] = useState(isEncryptionEnabled());
  const [settingUp, setSettingUp] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const [keyUnlock, setKeyUnlock] = useState(isKeyUnlockEnabled());
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [keyWorking, setKeyWorking] = useState(false);
  const [keyError, setKeyError] = useState<string>();

  // Deliberately separate from the encryption passphrase above - a backup's
  // passphrase is never the same key (see the plan's Decisions).
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupWorking, setBackupWorking] = useState(false);
  const [backupError, setBackupError] = useState<string>();

  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifWorking, setNotifWorking] = useState(false);
  const [notifError, setNotifError] = useState<string>();
  const [displayLevel, setDisplayLevel] = useState<PushDisplayLevel>("generic");

  const [typingEnabled, setTypingEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator)) return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setNotifEnabled(subscription !== null);
      setDisplayLevel(await loadPushDisplayLevel());
    })();
    loadTypingIndicatorEnabled().then(setTypingEnabled);
  }, []);

  async function handleToggleTypingIndicator(enabled: boolean) {
    await saveTypingIndicatorEnabled(enabled);
    setTypingEnabled(enabled);
  }

  const canSubmit = passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === confirm;

  async function handleEnable() {
    setWorking(true);
    setError(undefined);
    try {
      await enableEncryption(passphrase);
      setEnabled(true);
      setSettingUp(false);
      setPassphrase("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to enable encryption");
    } finally {
      setWorking(false);
    }
  }

  async function handleDisable() {
    setWorking(true);
    setError(undefined);
    try {
      await disableEncryption();
      setEnabled(false);
      setKeyUnlock(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to disable encryption");
    } finally {
      setWorking(false);
    }
  }

  async function handleEnableKeyUnlock() {
    setKeyWorking(true);
    setKeyError(undefined);
    try {
      await enableKeyUnlock(keyPassphrase);
      setKeyUnlock(true);
      setKeyPassphrase("");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "failed to set up the security key");
    } finally {
      setKeyWorking(false);
    }
  }

  function handleDisableKeyUnlock() {
    disableKeyUnlock();
    setKeyUnlock(false);
  }

  async function handleExportBackup() {
    setBackupWorking(true);
    setBackupError(undefined);
    try {
      const blob = await exportBackup(backupPassphrase);
      downloadBlob(blob, `umbrachat-backup-${new Date().toISOString().slice(0, 10)}.json`);
      setBackupPassphrase("");
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "failed to export backup");
    } finally {
      setBackupWorking(false);
    }
  }

  async function handleEnableNotifications() {
    setNotifWorking(true);
    setNotifError(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotifError("permission denied - allow notifications for this site in your browser settings to use this");
        return;
      }
      const vapidKey = await fetchPushPublicKey();

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidPublicKeyToUint8Array(vapidKey) as BufferSource,
      });
      await registerPushSubscription(subscription.toJSON(), account);
      await savePushDisplayLevel("generic");
      setDisplayLevel("generic");
      setNotifEnabled(true);
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : "failed to enable notifications");
    } finally {
      setNotifWorking(false);
    }
  }

  async function handleDisableNotifications() {
    setNotifWorking(true);
    setNotifError(undefined);
    try {
      await unregisterPushSubscription(account);
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      setNotifEnabled(false);
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : "failed to disable notifications");
    } finally {
      setNotifWorking(false);
    }
  }

  async function handleDisplayLevelChange(level: PushDisplayLevel) {
    setDisplayLevel(level);
    await savePushDisplayLevel(level);
  }

  return (
    <main className="screen">
      <div className="convo-toolbar">
        <button className="secondary" onClick={onBack} aria-label="Back to menu">
          ← Menu
        </button>
        <h1>Settings</h1>
      </div>

      <section className="panel stack" data-testid="server-info">
        <h2>Server</h2>
        <p className="chip chip--block" data-testid="server-url">
          {getServerUrl() || window.location.origin}
        </p>
        {isSameHostAsServer() && (
          <p className="hint" data-testid="same-host-warning">
            This app and your server come from the same host, so that host could change the app's code. For the strongest protection, use a copy of the app that you installed yourself and that asks you for the server.
          </p>
        )}
      </section>

      <section className="panel stack">
        <h2>Local Encryption</h2>
        {!settingUp ? (
          <>
            <div className="row">
              <span data-testid="encryption-status">{enabled ? "On" : "Off"}</span>
              {enabled ? (
                <button className="danger" onClick={handleDisable} disabled={working}>
                  {working ? "Disabling..." : "Disable"}
                </button>
              ) : (
                <button onClick={() => setSettingUp(true)} disabled={working}>
                  Enable
                </button>
              )}
            </div>
            <p className="hint">Protects your messages and keys if this device is lost or seized.</p>
          </>
        ) : (
          <div className="stack">
            <input
              type="password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={working}
            />
            <input
              type="password"
              placeholder="Confirm passphrase"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={working}
            />
            <button onClick={handleEnable} disabled={!canSubmit || working}>
              {working ? "Enabling..." : "Enable Encryption"}
            </button>
            <p className="hint">⚠ If you forget this, your messages can't be recovered.</p>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>

      {enabled && isKeyUnlockSupported() && (
        <section className="panel stack">
          <h2>Unlock with a security key</h2>
          {keyUnlock ? (
            <div className="row">
              <span data-testid="key-unlock-status">On</span>
              <button className="danger" onClick={handleDisableKeyUnlock}>
                Remove
              </button>
            </div>
          ) : (
            <div className="stack">
              <input
                type="password"
                placeholder="Current passphrase"
                value={keyPassphrase}
                onChange={(e) => setKeyPassphrase(e.target.value)}
                disabled={keyWorking}
              />
              <button onClick={handleEnableKeyUnlock} disabled={!keyPassphrase || keyWorking}>
                {keyWorking ? "Waiting for the key..." : "Set up security key"}
              </button>
            </div>
          )}
          <p className="hint">
            A security key, or this device's fingerprint, face or PIN, can then open UmbraChat; the passphrase keeps working. Whoever can pass that check can open the app, so a weak device PIN weakens it, and a passkey may be synced to your Apple, Google or Microsoft account.
          </p>
          {keyError && <p role="alert">{keyError}</p>}
        </section>
      )}

      <section className="panel stack">
        <h2>Backup</h2>
        <input
          type="password"
          placeholder="Passphrase"
          value={backupPassphrase}
          onChange={(e) => setBackupPassphrase(e.target.value)}
          disabled={backupWorking}
        />
        <button onClick={handleExportBackup} disabled={!backupPassphrase || backupWorking}>
          {backupWorking ? "Exporting..." : "Export Backup"}
        </button>
        <p className="hint">
          Saves an encrypted file you keep yourself. Forgetting this passphrase means the backup can't be restored.
        </p>
        {backupError && <p role="alert">{backupError}</p>}
      </section>

      <section className="panel stack">
        <h2>Notifications</h2>
        <div className="row">
          <span data-testid="notifications-status">{notifEnabled ? "On" : "Off"}</span>
          {notifEnabled ? (
            <button className="danger" onClick={handleDisableNotifications} disabled={notifWorking}>
              {notifWorking ? "Disabling..." : "Disable"}
            </button>
          ) : (
            <button onClick={handleEnableNotifications} disabled={notifWorking}>
              {notifWorking ? "Enabling..." : "Enable"}
            </button>
          )}
        </div>
        {notifEnabled && (
          <div className="stack" role="radiogroup" aria-label="Notification content">
            <label>
              <input
                type="radio"
                name="notif-level"
                checked={displayLevel === "generic"}
                onChange={() => handleDisplayLevelChange("generic")}
              />
              New message (generic)
            </label>
            <label>
              <input
                type="radio"
                name="notif-level"
                checked={displayLevel === "silent"}
                onChange={() => handleDisplayLevelChange("silent")}
              />
              Nothing shown (silent)
            </label>
          </div>
        )}
        <p className="hint">
          Works even when the app is closed - but on iPhone, only after adding it to your home screen.
        </p>
        {notifError && <p role="alert">{notifError}</p>}
      </section>

      <section className="panel stack">
        <h2>Typing Indicator</h2>
        <div className="row">
          <span data-testid="typing-indicator-status">{typingEnabled ? "On" : "Off"}</span>
          {typingEnabled ? (
            <button className="danger" onClick={() => handleToggleTypingIndicator(false)}>
              Disable
            </button>
          ) : (
            <button onClick={() => handleToggleTypingIndicator(true)}>Enable</button>
          )}
        </div>
        <p className="hint">Lets people you message see when you're typing. Off by default.</p>
      </section>
    </main>
  );
}
