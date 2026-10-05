import { chromium } from "playwright";
import { openTab } from "./ui-steps.mjs";

// Unlocking local encryption with a security key (WebAuthn PRF, crypto/vault.ts), against
// Chromium's virtual authenticator. Real hardware (Face ID, Touch ID, a YubiKey) is not covered.
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch();
const PASSPHRASE = "correct horse battery staple";

async function setUp(label, authenticatorOptions = {}) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      ...authenticatorOptions,
    },
  });
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const id = (await page.textContent('[data-testid="account-id"]')).trim();
  await openTab(page, "settings");
  await page.click("text=Enable");
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.fill('input[placeholder="Confirm passphrase"]', PASSPHRASE);
  await page.click('button:has-text("Enable Encryption")');
  await page.waitForSelector('[data-testid="encryption-status"]:has-text("On")', { timeout: 15000 });
  return { page, cdp, authenticatorId, id };
}

async function addKey(page, passphrase, name = "") {
  const before = await page.locator('[data-testid="unlock-key"]').count();
  const alerts = await page.locator('[role="alert"]').count();
  if (await page.locator('summary:text("Add another key")').count()) {
    await page.click('summary:text("Add another key")');
  }
  await page.fill('input[aria-label="New key name"]', name);
  await page.fill('input[placeholder="Current passphrase"]', passphrase);
  await page.click("text=Add security key");
  await page.waitForFunction(
    ([before, alerts]) => document.querySelectorAll('[data-testid="unlock-key"]').length > before || document.querySelectorAll('[role="alert"]').length > alerts,
    [before, alerts],
    { timeout: 15000 },
  );
}

const storedKeys = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("umbrachat:vaultKeyUnlock") ?? "[]"));
const keyNames = (page) => page.locator('[data-testid="unlock-key"] input').evaluateAll((inputs) => inputs.map((i) => i.value));
const lastAlert = async (page) => ((await page.locator('[role="alert"]').count()) ? (await page.locator('[role="alert"]').last().textContent()).trim() : "");
// Only the authenticators with presence simulated answer a request, as if only they were plugged in.
const plugIn = (cdp, ids, on) => Promise.all(ids.map((authenticatorId) => cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: on })));

async function lockedAgain(page) {
  await page.reload();
  await page.waitForSelector('h1:has-text("Locked")', { timeout: 15000 });
}

async function unlockedAs(page, id) {
  await openTab(page, "me");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return (await page.textContent('[data-testid="account-id"]')).trim() === id;
}

async function unlockWithPassphrase(page, id) {
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.click('button:text-is("Unlock")');
  return unlockedAs(page, id);
}

// A step that breaks reports a FAIL instead of leaving the browser open.
try {
  const { page, cdp, authenticatorId: phone, id } = await setUp("main");

  await addKey(page, "not the passphrase", "Phone");
  check("adding a key with a wrong passphrase is refused", (await lastAlert(page)) === "wrong passphrase" && (await storedKeys(page)).length === 0, await lastAlert(page));

  await addKey(page, PASSPHRASE, "Phone");
  check("with the right passphrase the key is registered under its name", JSON.stringify(await keyNames(page)) === '["Phone"]' && !!(await storedKeys(page))[0]?.wrappedKey, JSON.stringify(await keyNames(page)));

  // A second authenticator, the only one "plugged in" while it is added.
  const { authenticatorId: blue } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await plugIn(cdp, [phone], false);
  await addKey(page, PASSPHRASE, "");
  check("a second key can be added, with a default name", JSON.stringify(await keyNames(page)) === '["Phone","Security key 2"]', JSON.stringify(await keyNames(page)));

  await page.fill('[data-testid="unlock-key"]:nth-child(2) input', "Blue key");
  await page.press('[data-testid="unlock-key"]:nth-child(2) input', "Enter");
  await page.fill('[data-testid="unlock-key"]:nth-child(1) input', "   ");
  await page.press('[data-testid="unlock-key"]:nth-child(1) input', "Enter");
  await page.reload();
  await unlockWithPassphrase(page, id);
  await openTab(page, "settings");
  check("a key can be renamed, an empty name keeps the old one", JSON.stringify(await keyNames(page)) === '["Phone","Blue key"]', JSON.stringify(await keyNames(page)));

  await addKey(page, PASSPHRASE, "Blue again");
  check("the same authenticator cannot be added twice", (await storedKeys(page)).length === 2 && !!(await lastAlert(page)), await lastAlert(page));

  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  check("the second key unlocks the app", await unlockedAs(page, id));

  await plugIn(cdp, [blue], false);
  await plugIn(cdp, [phone], true);
  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  check("the first key unlocks it too", await unlockedAs(page, id));

  await lockedAgain(page);
  check("the passphrase still unlocks it on its own", await unlockWithPassphrase(page, id));

  // Another PRF secret (the stored salt changed) cannot unwrap the vault key.
  const keys = await storedKeys(page);
  await page.evaluate(() => {
    const keys = JSON.parse(localStorage.getItem("umbrachat:vaultKeyUnlock"));
    const salt = Uint8Array.from(atob(keys[0].salt), (c) => c.charCodeAt(0));
    salt[0] ^= 1;
    keys[0].salt = btoa(String.fromCharCode(...salt));
    localStorage.setItem("umbrachat:vaultKeyUnlock", JSON.stringify(keys));
  });
  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  await page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("a secret that does not unwrap the vault key is refused", (await lastAlert(page)).includes("does not open this app") && (await page.locator('h1:has-text("Locked")').isVisible()), await lastAlert(page));

  // A record stored before several keys were allowed (one object, no name) still works.
  const { name: _, ...legacy } = keys[0];
  await page.evaluate((r) => localStorage.setItem("umbrachat:vaultKeyUnlock", r), JSON.stringify(legacy));
  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  check("a key stored by the previous version still unlocks", await unlockedAs(page, id));
  await openTab(page, "settings");
  check("and is listed under a default name", JSON.stringify(await keyNames(page)) === '["Security key"]', JSON.stringify(await keyNames(page)));
  await page.evaluate((r) => localStorage.setItem("umbrachat:vaultKeyUnlock", r), JSON.stringify(keys));

  // Removing one key leaves the other working; removing the last takes the button away.
  await page.reload();
  await unlockWithPassphrase(page, id);
  await openTab(page, "settings");
  await page.click('[data-testid="unlock-key"]:nth-child(1) button:text("Remove")');
  check("Remove takes only that key away", JSON.stringify(await keyNames(page)) === '["Blue key"]', JSON.stringify(await keyNames(page)));
  await plugIn(cdp, [phone], false);
  await plugIn(cdp, [blue], true);
  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  check("the remaining key still unlocks", await unlockedAs(page, id));
  await openTab(page, "settings");
  await page.click('[data-testid="unlock-key"] button:text("Remove")');
  await lockedAgain(page);
  check("after the last Remove, the locked screen offers no security key", (await page.locator("text=Unlock with security key").count()) === 0 && (await storedKeys(page)).length === 0);

  await unlockWithPassphrase(page, id);
  await openTab(page, "settings");
  await addKey(page, PASSPHRASE, "Blue key");
  await page.click("text=Disable");
  await page.waitForSelector('[data-testid="encryption-status"]:has-text("Off")', { timeout: 15000 });
  check("turning encryption off forgets the security keys", (await storedKeys(page)).length === 0);

  // The authenticator refuses (user not verified): the app stays locked and says so. In its own
  // context: Chromium's virtual authenticator keeps refusing after being set back to verified.
  {
    const uv = await setUp("uv");
    await addKey(uv.page, PASSPHRASE);
    await lockedAgain(uv.page);
    await uv.cdp.send("WebAuthn.setUserVerified", { authenticatorId: uv.authenticatorId, isUserVerified: false });
    await uv.page.click("text=Unlock with security key");
    await uv.page.waitForSelector('[role="alert"]', { timeout: 15000 });
    check("an authenticator that does not verify the user does not unlock", (await lastAlert(uv.page)).includes("Security key unlock failed") && (await uv.page.locator('h1:has-text("Locked")').isVisible()), await lastAlert(uv.page));
  }

  // An authenticator without PRF: a clear refusal, nothing stored.
  {
    const noPrf = await setUp("no-prf", { hasPrf: false });
    await addKey(noPrf.page, PASSPHRASE);
    check("an authenticator without PRF is refused with an explanation", (await lastAlert(noPrf.page)).includes("PRF") && (await storedKeys(noPrf.page)).length === 0, await lastAlert(noPrf.page));
  }
} catch (err) {
  check("the run reached its end", false, String(err).split("\n")[0]);
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
