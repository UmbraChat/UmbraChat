import type { LocalAccount } from "../storage/keyStore";
import type { IdentityBundle } from "../crypto/identity";
import { signedFetch } from "./signedRequest";
import { identityBundleToJson, isUuid } from "./codec";
import { apiFetch } from "./server";

export interface DeviceInfo {
  id: string;
  label: string;
  createdAt: string;
}

/** No ownership check server-side: also used to discover a contact's devices for fan-out. */
export async function listDevices(accountId: string, account: LocalAccount): Promise<DeviceInfo[]> {
  const response = await signedFetch(`/v1/accounts/${accountId}/devices`, "GET", account);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to list devices" }));
    throw new Error(error.error ?? "failed to list devices");
  }
  const raw = (await response.json()) as { id: string; label: string; created_at: string }[];
  return raw.filter((d) => isUuid(d.id)).map((d) => ({ id: d.id, label: String(d.label).slice(0, 100), createdAt: String(d.created_at) }));
}

export async function linkInit(account: LocalAccount): Promise<string> {
  const response = await signedFetch(`/v1/accounts/${account.accountId}/devices/link-init`, "POST", account);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to start device link" }));
    throw new Error(error.error ?? "failed to start device link");
  }
  const { code } = (await response.json()) as { code: string };
  return code;
}

/** Unauthenticated - the new device has no credentials yet; the code is what authorizes this. */
export async function completeLink(accountId: string, code: string, label: string, identity: IdentityBundle): Promise<string> {
  const body = { code, label, ...identityBundleToJson(identity) };
  const response = await apiFetch(`/v1/accounts/${accountId}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "failed to complete device link" }));
    throw new Error(error.error ?? "failed to complete device link");
  }
  const { device_id } = (await response.json()) as { device_id: string };
  if (!isUuid(device_id)) throw new Error("the server sent an invalid device id");
  return device_id;
}
