import type { LocalAccount } from "../storage/keyStore";
import { signedFetch } from "./signedRequest";
import { apiFetch } from "./server";

/** The VAPID public key is base64url (the format the web-push ecosystem
 * uses everywhere, including the server's own key generation) - api/codec.ts's
 * fromBase64 uses atob() directly, which only understands standard base64
 * (+/ instead of -_), so it can't be reused here without first converting. */
export function vapidPublicKeyToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The server's own VAPID public key, so a client not built for one server can still subscribe to push. */
export async function fetchPushPublicKey(): Promise<string> {
  const response = await apiFetch("/v1/push-key");
  if (!response.ok) throw new Error("push notifications aren't configured on this server");
  return ((await response.json()) as { public_key: string }).public_key;
}

export async function registerPushSubscription(subscription: PushSubscriptionJSON, account: LocalAccount): Promise<void> {
  const response = await signedFetch(`/v1/devices/${account.deviceId}/push-subscription`, "POST", account, {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys!.p256dh, auth: subscription.keys!.auth },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to register push subscription" }));
    throw new Error(error.error ?? "failed to register push subscription");
  }
}

export async function unregisterPushSubscription(account: LocalAccount): Promise<void> {
  const response = await signedFetch(`/v1/devices/${account.deviceId}/push-subscription`, "DELETE", account);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to unregister push subscription" }));
    throw new Error(error.error ?? "failed to unregister push subscription");
  }
}
