import type { LocalAccount } from "../storage/keyStore";
import { signWithIdentity } from "../crypto/identity";
import { toBase64 } from "./codec";

import { apiFetch } from "./server";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Signs method+path+timestamp+body-hash with the local identity private key,
 * the same shape the server's auth extractor verifies (see server/src/auth.rs).
 */
export async function signedFetch(path: string, method: "GET" | "POST" | "DELETE", account: LocalAccount, body?: unknown): Promise<Response> {
  const bodyText = body ? JSON.stringify(body) : "";
  const bodyHash = await sha256Hex(new TextEncoder().encode(bodyText));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // The server verifies the path without its query string.
  const message = new TextEncoder().encode(`${method}\n${path.split("?")[0]}\n${timestamp}\n${bodyHash}`);
  const signature = await signWithIdentity(account.identity.identity_private_key, message);

  return apiFetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-device-id": account.deviceId,
      "x-timestamp": timestamp,
      "x-signature": toBase64(signature),
    },
    body: body ? bodyText : undefined,
  });
}
