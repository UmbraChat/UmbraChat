import { chromium } from "playwright";

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
  await page.click("text=Settings");
  await page.click("text=Enable");
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.fill('input[placeholder="Confirm passphrase"]', PASSPHRASE);
  await page.click('button:has-text("Enable Encryption")');
  await page.waitForSelector('[data-testid="encryption-status"]:has-text("On")', { timeout: 15000 });
  return { page, cdp, authenticatorId, id };
}

async function setUpKey(page, passphrase) {
  await page.fill('input[placeholder="Current passphrase"]', passphrase);
  await page.click("text=Set up security key");
  await page.waitForFunction(() => document.querySelector('[data-testid="key-unlock-status"]') || document.querySelectorAll('[role="alert"]').length > 0, null, { timeout: 15000 });
}

const storedRecord = (page) => page.evaluate(() => localStorage.getItem("umbrachat:vaultKeyUnlock"));
const lastAlert = async (page) => ((await page.locator('[role="alert"]').count()) ? (await page.locator('[role="alert"]').last().textContent()).trim() : "");

async function lockedAgain(page) {
  await page.reload();
  await page.waitForSelector('h1:has-text("Locked")', { timeout: 15000 });
}

// A step that breaks reports a FAIL instead of leaving the browser open.
try {
  const { page, id } = await setUp("main");

  await setUpKey(page, "not the passphrase");
  check("setting up a key with a wrong passphrase is refused", (await lastAlert(page)) === "wrong passphrase" && !(await storedRecord(page)), await lastAlert(page));

  await page.fill('input[placeholder="Current passphrase"]', "");
  await setUpKey(page, PASSPHRASE);
  const record = JSON.parse((await storedRecord(page)) ?? "null");
  check("with the right passphrase the key is registered", (await page.locator('[data-testid="key-unlock-status"]').count()) === 1 && !!record?.wrappedKey && !!record?.credentialId);

  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  check("the security key unlocks the app", (await page.textContent('[data-testid="account-id"]')).trim() === id);

  await lockedAgain(page);
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.click('button:text-is("Unlock")');
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  check("the passphrase still unlocks it on its own", (await page.textContent('[data-testid="account-id"]')).trim() === id);

  // Another PRF secret (the stored salt changed) cannot unwrap the vault key.
  await page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem("umbrachat:vaultKeyUnlock"));
    const salt = Uint8Array.from(atob(r.salt), (c) => c.charCodeAt(0));
    salt[0] ^= 1;
    localStorage.setItem("umbrachat:vaultKeyUnlock", JSON.stringify({ ...r, salt: btoa(String.fromCharCode(...salt)) }));
  });
  await lockedAgain(page);
  await page.click("text=Unlock with security key");
  await page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("a secret that does not unwrap the vault key is refused", (await lastAlert(page)).includes("does not open this app") && (await page.locator('h1:has-text("Locked")').isVisible()), await lastAlert(page));
  await page.evaluate((r) => localStorage.setItem("umbrachat:vaultKeyUnlock", r), JSON.stringify(record));

  // Removing it in Settings takes the button away; turning encryption off forgets it too.
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.click('button:text-is("Unlock")');
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  await page.click("text=Settings");
  await page.click('[data-testid="key-unlock-status"] + button');
  await lockedAgain(page);
  check("after Remove, the locked screen offers no security key", (await page.locator("text=Unlock with security key").count()) === 0 && !(await storedRecord(page)));
  await page.fill('input[placeholder="Passphrase"]', PASSPHRASE);
  await page.click('button:text-is("Unlock")');
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  await page.click("text=Settings");
  await setUpKey(page, PASSPHRASE);
  await page.click("text=Disable");
  await page.waitForSelector('[data-testid="encryption-status"]:has-text("Off")', { timeout: 15000 });
  check("turning encryption off forgets the security key", !(await storedRecord(page)));

  // The authenticator refuses (user not verified): the app stays locked and says so. In its own
  // context: Chromium's virtual authenticator keeps refusing after being set back to verified.
  {
    const uv = await setUp("uv");
    await setUpKey(uv.page, PASSPHRASE);
    await lockedAgain(uv.page);
    await uv.cdp.send("WebAuthn.setUserVerified", { authenticatorId: uv.authenticatorId, isUserVerified: false });
    await uv.page.click("text=Unlock with security key");
    await uv.page.waitForSelector('[role="alert"]', { timeout: 15000 });
    check("an authenticator that does not verify the user does not unlock", (await lastAlert(uv.page)).includes("Security key unlock failed") && (await uv.page.locator('h1:has-text("Locked")').isVisible()), await lastAlert(uv.page));
  }

  // An authenticator without PRF: a clear refusal, nothing stored.
  {
    const noPrf = await setUp("no-prf", { hasPrf: false });
    await setUpKey(noPrf.page, PASSPHRASE);
    check("an authenticator without PRF is refused with an explanation", (await lastAlert(noPrf.page)).includes("PRF") && !(await storedRecord(noPrf.page)), await lastAlert(noPrf.page));
  }
} catch (err) {
  check("the run reached its end", false, String(err).split("\n")[0]);
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
