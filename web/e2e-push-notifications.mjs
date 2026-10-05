import { chromium } from "playwright";
import { openTab } from "./ui-steps.mjs";
import { execSync } from "node:child_process";

const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

function subscriptionRowCount(deviceId) {
  const out = execSync(
    `${process.env.DB_EXEC ?? "podman exec -i umbrachat-postgres"} psql -U ${process.env.DB_USER ?? "umbrachat"} -d ${process.env.DB_NAME ?? "umbrachat"} -tAc "select count(*) from push_subscriptions where device_id = '${deviceId}'"`,
  );
  return parseInt(out.toString().trim(), 10);
}

const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(["notifications"]);

// Headless Chromium's real Push service registration (GCM) doesn't work in
// this sandboxed environment (verified: subscribe() rejects with
// "Registration failed - permission denied" even with reachable network and
// granted permission - a Chromium headless-mode limitation, not a bug in our
// code). Stub PushManager itself so the test exercises OUR code (the request
// shape sent to our own server, and the disable cleanup) against a real
// fetch round trip, without depending on a real push service being reachable
// from a headless browser. Real end-to-end delivery is verified by phone.
await context.addInitScript(() => {
  let fakeSub = null;
  function makeFakeSubscription() {
    return {
      endpoint: "https://example-push-service.test/fake-endpoint",
      toJSON() {
        return {
          endpoint: this.endpoint,
          keys: { p256dh: "BFakeP256dhKeyBFakeP256dhKeyBFakeP256dhKeyBFakeP256dhKeyBFa", auth: "FakeAuthSecret1" },
        };
      },
      unsubscribe: async () => {
        fakeSub = null;
        return true;
      },
    };
  }
  window.PushManager.prototype.subscribe = async function () {
    fakeSub = makeFakeSubscription();
    return fakeSub;
  };
  window.PushManager.prototype.getSubscription = async function () {
    return fakeSub;
  };
});

const page = await context.newPage();
await page.goto("http://localhost:5173");
await page.click("text=Create Account");
await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });

const deviceId = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("umbrachat", 2);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const account = await new Promise((resolve, reject) => {
    const r = db.transaction("identity", "readonly").objectStore("identity").get("self");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return account.deviceId;
});
check("device id is readable for the direct-DB checks below", !!deviceId, deviceId);

await openTab(page, "settings");
await page.waitForSelector('[data-testid="notifications-status"]', { timeout: 15000 });
const statusBefore = await page.textContent('[data-testid="notifications-status"]');
check("status starts Off", statusBefore.trim() === "Off", statusBefore);
check("no subscription row exists yet server-side", subscriptionRowCount(deviceId) === 0);

const notifPanel = page.locator("section", { has: page.locator("h2", { hasText: "Notifications" }) });
await notifPanel.locator('button:has-text("Enable")').click();
await page.waitForFunction(
  () => document.querySelector('[data-testid="notifications-status"]')?.textContent?.trim() === "On",
  { timeout: 15000 },
);
check("status becomes On after enabling", true);
check("registerPushSubscription's request body round-tripped to a real server-side row", subscriptionRowCount(deviceId) === 1);

// --- Display-level radio updates without disabling/re-enabling ---
await page.click('label:has-text("Nothing shown (silent)") input');
await page.waitForTimeout(200);
const savedLevel = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("umbrachat-push-prefs", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    const r = db.transaction("prefs", "readonly").objectStore("prefs").get("displayLevel");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
});
check("choosing 'silent' persists immediately, no re-subscribe needed", savedLevel === "silent", savedLevel);

// --- Toggling Off actually removes the server-side subscription row ---
await notifPanel.locator('button:has-text("Disable")').click();
await page.waitForFunction(
  () => document.querySelector('[data-testid="notifications-status"]')?.textContent?.trim() === "Off",
  { timeout: 15000 },
);
check("the server-side subscription row is gone after disabling (checked directly in Postgres)", subscriptionRowCount(deviceId) === 0);

console.log(checks.every(Boolean) ? "\nAll checks passed." : "\nSome checks FAILED.");
await browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
