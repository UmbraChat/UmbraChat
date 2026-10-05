import type { LocalAccount } from "../storage/keyStore";
import { submitStatement, type PendingDevice } from "../api/chain";
import { adoptChain, verifiedChain } from "./chains";
import { headOf, signStatement, type DeviceEntry } from "./deviceList";

/**
 * Publishes the next statement of this account's device list, signed by this device, with the
 * device set `change` makes from the current verified one. The server applies it (activating
 * the added devices, deleting the dropped ones) only if it is a valid continuation.
 */
async function publish(account: LocalAccount, change: (devices: DeviceEntry[]) => DeviceEntry[]): Promise<void> {
  const state = await verifiedChain(account.accountId, account);
  const devices = change(state.devices);
  if (devices.length === 0) throw new Error("an account cannot be left without a device");
  const signed = await signStatement(
    { accountId: account.accountId, version: state.version + 1, prevHead: state.head, signerDeviceId: account.deviceId, devices },
    account.identity.identity_private_key,
  );
  await submitStatement(account.accountId, signed, account);
  await adoptChain({ accountId: account.accountId, version: state.version + 1, head: await headOf(signed), devices });
}

/** The user compared this device's key with the one shown on the new device and accepted it. */
export function acceptDevice(account: LocalAccount, pending: PendingDevice): Promise<void> {
  return publish(account, (devices) => {
    if (devices.some((d) => d.deviceId === pending.id)) throw new Error("this device is already in the list");
    return [...devices, { deviceId: pending.id, identityKey: pending.identityKey }];
  });
}

/** Any device still in the list may remove another, so a lost one can be cut off from a remaining one. */
export function removeDevice(account: LocalAccount, deviceId: string): Promise<void> {
  return publish(account, (devices) => devices.filter((d) => d.deviceId !== deviceId));
}
