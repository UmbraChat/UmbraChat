import type { LocalAccount } from "../storage/keyStore";
import type { SignedStatement } from "../crypto/deviceList";
import { signedFetch } from "./signedRequest";
import { apiFetch } from "./server";
import { fromBase64, isUuid, toBase64 } from "./codec";

/** The server could not be reached or answered with an error: worth trying again later, unlike a chain that does not verify. */
export class ChainUnavailableError extends Error {}

/** Statements of `accountId` newer than version `since`, oldest first. Nothing here is trusted: callers verify. */
export async function fetchStatements(accountId: string, since: number, account: LocalAccount): Promise<SignedStatement[]> {
  let response: Response;
  try {
    response = await signedFetch(`/v1/accounts/${accountId}/device-list?since=${since}`, "GET", account);
  } catch (err) {
    throw new ChainUnavailableError(err instanceof Error ? err.message : "could not reach the server");
  }
  if (!response.ok) throw new ChainUnavailableError(`the server refused to give the device list (${response.status})`);
  const raw = (await response.json()) as { statement: string; signature: string }[];
  if (!Array.isArray(raw)) throw new Error("the server sent a malformed device list");
  return raw.map((r) => ({ bytes: fromBase64(r.statement), signature: fromBase64(r.signature) }));
}

export async function submitStatement(accountId: string, statement: SignedStatement, account: LocalAccount): Promise<void> {
  const response = await signedFetch(`/v1/accounts/${accountId}/device-list`, "POST", account, {
    statement: toBase64(statement.bytes),
    signature: toBase64(statement.signature),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to update the device list" }));
    throw new Error(error.error ?? "failed to update the device list");
  }
}

export interface PendingDevice {
  id: string;
  label: string;
  identityKey: Uint8Array;
}

/** Devices waiting for this account to accept them, with the key they registered. */
export async function listPendingDevices(account: LocalAccount): Promise<PendingDevice[]> {
  const response = await signedFetch(`/v1/accounts/${account.accountId}/pending-devices`, "GET", account);
  if (!response.ok) throw new Error("failed to list the devices waiting to be accepted");
  const raw = (await response.json()) as { id: string; label: string; identity_public_key: string }[];
  return raw
    .filter((d) => isUuid(d.id))
    .map((d) => ({ id: d.id, label: String(d.label).slice(0, 100), identityKey: fromBase64(d.identity_public_key) }));
}

/** Unauthenticated: a device that is not accepted yet cannot sign requests. */
export async function fetchDeviceActive(deviceId: string): Promise<boolean> {
  const response = await apiFetch(`/v1/devices/${deviceId}/status`);
  if (!response.ok) throw new Error("this device is no longer waiting to be accepted");
  return ((await response.json()) as { active: boolean }).active === true;
}
