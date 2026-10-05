import { generateSignedPrekeys, type IdentityBundle } from "./identity";
import { openStore } from "./session";
import { uploadSignedPrekeys } from "../api/prekeyBundle";
import { loadAccount, saveAccount, withAccountLock } from "../storage/keyStore";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long one pair of signed prekeys is served before it is replaced. */
export const ROTATE_AFTER_MS = 7 * DAY_MS;
/**
 * How long a replaced pair is kept. A first message built against it was queued before the
 * server stopped serving it, and the server drops queued messages after MESSAGE_TTL_DAYS (30 by
 * default): keeping the private keys that long means no such message fails for lack of them.
 */
export const RETAIN_RETIRED_MS = 30 * DAY_MS;

function nextKeyId(identity: IdentityBundle): number {
  const pairs = [identity, ...(identity.pending_prekeys ? [identity.pending_prekeys] : []), ...(identity.retired_prekeys ?? [])];
  return Math.max(...pairs.flatMap((p) => [p.signed_prekey.key_id, p.kyber_signed_prekey.key_id])) + 1;
}

/**
 * Replaces this device's signed prekeys once they are older than ROTATE_AFTER_MS, and forgets
 * replaced ones after RETAIN_RETIRED_MS, so a leaked old prekey stops being useful. The new pair
 * is saved before it is uploaded, and only replaces the served one once the server confirmed it:
 * the private key of whatever the server may hand out is never lost.
 */
export function rotateSignedPrekeysIfDue(): Promise<void> {
  return withAccountLock(async () => {
    const account = await loadAccount();
    if (!account) return;
    const now = Date.now();
    let identity = account.identity;
    const save = async () => {
      await saveAccount({ ...account, identity });
    };

    const kept = (identity.retired_prekeys ?? []).filter((pair) => now - pair.retired_at < RETAIN_RETIRED_MS);
    if (kept.length !== (identity.retired_prekeys ?? []).length) {
      identity = { ...identity, retired_prekeys: kept };
      await save();
    }

    let pending = identity.pending_prekeys;
    if (!pending) {
      if (now - (identity.prekeys_created_at ?? 0) < ROTATE_AFTER_MS) return;
      pending = await generateSignedPrekeys(identity, nextKeyId(identity));
      identity = { ...identity, pending_prekeys: pending };
      await save();
      (await openStore(identity)).add_signed_prekeys(pending);
    }

    if (!(await uploadSignedPrekeys({ ...account, identity }, pending))) {
      identity = { ...identity, pending_prekeys: undefined };
      await save();
      return;
    }

    const replaced = { signed_prekey: identity.signed_prekey, kyber_signed_prekey: identity.kyber_signed_prekey, created_at: identity.prekeys_created_at ?? 0, retired_at: now };
    identity = {
      ...identity,
      signed_prekey: pending.signed_prekey,
      kyber_signed_prekey: pending.kyber_signed_prekey,
      prekeys_created_at: pending.created_at,
      pending_prekeys: undefined,
      retired_prekeys: [...(identity.retired_prekeys ?? []), replaced],
    };
    await save();
  });
}
