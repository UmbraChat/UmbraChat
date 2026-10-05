import type { LocalAccount } from "../storage/keyStore";
import { SafetyNumber } from "./SafetyNumber";
import { LinkedDevices } from "./LinkedDevices";

interface MeProps {
  account: LocalAccount;
  safetyNumber: string;
  onGetInvite: () => Promise<string>;
}

/** Everything about this account: what to share with contacts, and the devices in it. */
export function Me({ account, safetyNumber, onGetInvite }: MeProps) {
  return (
    <div className="page">
      <h1>Me</h1>
      <SafetyNumber accountId={account.accountId} safetyNumber={safetyNumber} onGetInvite={onGetInvite} />
      <LinkedDevices account={account} />
    </div>
  );
}
