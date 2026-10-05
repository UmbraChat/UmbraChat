import type { IdentityBundle } from "../crypto/identity";
import { identityBundleToJson, toBase64 } from "./codec";
import { genesisStatement, signStatement } from "../crypto/deviceList";

import { apiFetch } from "./server";

export interface RegisteredAccount {
  accountId: string;
  deviceId: string;
}

/**
 * Registers a new account. The ids are chosen here, not by the server: they are inside the
 * first statement of the account's signed device list, which has to be signed before it is sent.
 */
export async function registerAccount(identity: IdentityBundle): Promise<RegisteredAccount> {
  const accountId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const genesis = await signStatement(genesisStatement(accountId, { deviceId, identityKey: Uint8Array.from(identity.identity_public_key) }), identity.identity_private_key);

  const response = await apiFetch("/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account_id: accountId,
      device_id: deviceId,
      device_list: { statement: toBase64(genesis.bytes), signature: toBase64(genesis.signature) },
      ...identityBundleToJson(identity),
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "registration failed" }));
    throw new Error(error.error ?? "registration failed");
  }

  const body = (await response.json()) as { account_id: string; device_id: string };
  if (body.account_id !== accountId || body.device_id !== deviceId) throw new Error("the server answered with other ids than the ones registered");
  return { accountId, deviceId };
}
