import type { LocalAccount } from "../storage/keyStore";
import { signedFetch } from "./signedRequest";
import { toBase64, fromBase64, isUuid } from "./codec";

export async function sendMessage(recipientDeviceId: string, envelope: Uint8Array, account: LocalAccount): Promise<void> {
  const response = await signedFetch("/v1/messages", "POST", account, {
    recipient_device_id: recipientDeviceId,
    ciphertext: toBase64(envelope),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to send message" }));
    throw new Error(error.error ?? "failed to send message");
  }
}

export interface ReceivedMessage {
  senderAccountId: string;
  senderDeviceId: string;
  envelope: Uint8Array;
  createdAt: string;
}

export async function fetchMessages(account: LocalAccount): Promise<ReceivedMessage[]> {
  const response = await signedFetch("/v1/messages", "GET", account);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to fetch messages" }));
    throw new Error(error.error ?? "failed to fetch messages");
  }

  // The server already deleted this batch: one bad item must not cost the others, so each is
  // checked on its own and the unusable ones are dropped.
  const raw = (await response.json()) as { sender_account_id: string; sender_device_id: string; ciphertext: string; created_at: string }[];
  const out: ReceivedMessage[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    try {
      if (!isUuid(m.sender_account_id) || !isUuid(m.sender_device_id)) throw new Error("bad sender id");
      out.push({ senderAccountId: m.sender_account_id, senderDeviceId: m.sender_device_id, envelope: fromBase64(m.ciphertext), createdAt: String(m.created_at) });
    } catch (err) {
      console.warn("dropped an unusable message from the server:", err);
    }
  }
  return out;
}
