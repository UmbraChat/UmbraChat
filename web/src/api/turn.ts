import type { LocalAccount } from "../storage/keyStore";
import { signedFetch } from "./signedRequest";

/** Short-lived relay credentials, or null when the server has no TURN relay configured (calls then fall back to STUN only). */
export async function fetchTurnServer(account: LocalAccount): Promise<RTCIceServer | null> {
  try {
    const response = await signedFetch("/v1/turn-credentials", "GET", account);
    if (!response.ok) return null;
    const { urls, username, credential } = (await response.json()) as { urls: string[]; username: string; credential: string };
    return { urls, username, credential };
  } catch {
    return null;
  }
}
