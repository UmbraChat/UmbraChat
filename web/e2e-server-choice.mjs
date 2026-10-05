import { chromium } from "playwright";
import { startChat, openTab, unfold } from "./ui-steps.mjs";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Needs the API on http://localhost:3000 and the dev server on :5173 (an instance's page: same origin, proxied).
// Also builds a copy of the app with VITE_REQUIRE_SERVER_URL=1 (no same-origin default) and serves
// it on :5174 to check the "choose a server first" behaviour.
const API = "http://localhost:3000";
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const text = async (page, selector) => (await page.textContent(selector)).trim();

const outDir = join(mkdtempSync(join(tmpdir(), "umbra-required-")), "dist");
execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], { env: { ...process.env, VITE_REQUIRE_SERVER_URL: "1" }, stdio: "ignore" });
const preview = spawn("npx", ["vite", "preview", "--outDir", outDir, "--port", "5174", "--strictPort"], { stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch("http://localhost:5174/").then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch();
async function newPage(origin) {
  const page = await (await browser.newContext()).newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(origin);
  return { page, requests };
}

try {
  // 1. An instance's own page talks only to its own server: no server field, a way to the installed app instead.
  const bob = await newPage("http://localhost:5173");
  check("an instance's page says the account will live on that instance", (await text(bob.page, '[data-testid="instance-server"]')).includes("localhost:5173"));
  check("and asks no server address", (await bob.page.locator('[data-testid="server-input"]').count()) === 0);
  check("and offers no other server, only the installed app", (await bob.page.locator("text=Use another server").count()) === 0 && (await bob.page.locator('[data-testid="instance-server"] a').getAttribute("href")).endsWith("/releases"));
  check("and shows no warning about a published page", (await bob.page.locator('[data-testid="hosted-notice"]').count()) === 0);
  // A server stored on this device earlier (when the option existed) is ignored: its policy would block it anyway.
  await bob.page.evaluate((api) => localStorage.setItem("umbrachat-server-url", api), API);
  await bob.page.reload();
  await bob.page.click("text=Create Account");
  await bob.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const bobId = await text(bob.page, '[data-testid="account-id"]');
  check("its account is made on its own server, never on a server stored earlier", bob.requests.some((u) => u.startsWith("http://localhost:5173/v1/register")) && !bob.requests.some((u) => u.startsWith(`${API}/v1/register`)));

  // 2. The client built without a same-origin default must be told the server.
  const alice = await newPage("http://localhost:5174");
  const violations = [];
  alice.page.on("console", (m) => m.text().includes("Content Security Policy") && violations.push(m.text()));
  check("the build carries its own Content-Security-Policy", (await alice.page.content()).includes('http-equiv="Content-Security-Policy"'));
  await alice.page.waitForSelector('[data-testid="server-input"]', { timeout: 10000 });
  check("the generic build served from this device asks for a server without the published-page warning", (await alice.page.locator('[data-testid="hosted-notice"]').count()) === 0);
  check("with no server chosen, creating an account is not possible", await alice.page.locator("button", { hasText: "Create Account" }).isDisabled());

  // 3. Unusable addresses are refused before any request.
  for (const input of ["javascript:alert(1)", "http://evil.example", "ftp://evil.example", "https://user:pw@evil.example"]) {
    await alice.page.fill('[data-testid="server-input"]', input);
    await alice.page.click("text=Create Account");
    await alice.page.waitForSelector('[data-testid="server-error"]', { timeout: 5000 });
    check(`refuses "${input}"`, true);
  }
  check("and never contacted it", !alice.requests.some((u) => u.includes("evil.example") || u.includes("/v1/register")), alice.requests.join(" "));

  await alice.page.fill('[data-testid="server-input"]', API);
  await alice.page.click("text=Create Account");
  await alice.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const aliceId = await text(alice.page, '[data-testid="account-id"]');
  check("once a server is entered it receives the requests directly", alice.requests.some((u) => u.startsWith(`${API}/v1/register`)), alice.requests.filter((u) => u.includes("/v1/")).join(" "));
  check("and none go through the app's own host", !alice.requests.some((u) => u.startsWith("http://localhost:5174/v1/")));
  check("and nothing it needs is blocked by its policy", violations.length === 0, violations.join(" | "));

  // 4. Someone on the instance's page can talk to them: same database behind both.
  await startChat(alice.page, bobId);
  await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
  await alice.page.fill('input[placeholder="Type a message..."]', "across origins");
  await alice.page.click('button[aria-label="Send"]');
  await startChat(bob.page, aliceId);
  await bob.page.waitForSelector('[data-testid="message-received"]:has-text("across origins")', { timeout: 20000 });
  check("messages cross between the installed app and the instance's page", true);

  // 5. Settings shows the server and warns only when the app and the server share a host.
  await alice.page.click('button[aria-label="Back to menu"]');
  await openTab(alice.page, "settings");
  await alice.page.waitForSelector('[data-testid="server-url"]', { timeout: 10000 });
  check("settings shows the chosen server", (await text(alice.page, '[data-testid="server-url"]')) === API);
  check("no same-host warning when the server is elsewhere", (await alice.page.locator('[data-testid="same-host-warning"]').count()) === 0);
  await bob.page.click('button[aria-label="Back to menu"]');
  await openTab(bob.page, "settings");
  await bob.page.waitForSelector('[data-testid="server-url"]', { timeout: 10000 });
  check("same-host warning when the app and server share an origin", (await bob.page.locator('[data-testid="same-host-warning"]').count()) === 1);

  // A backup of an account on another server is refused by an instance's page instead of stranding it there.
  await alice.page.fill('input[placeholder="Passphrase"]', "backup-passphrase");
  const downloading = alice.page.waitForEvent("download");
  await alice.page.click("text=Export Backup");
  const backupPath = join(mkdtempSync(join(tmpdir(), "umbra-backup-")), "backup.json");
  await (await downloading).saveAs(backupPath);
  const restorer = await newPage("http://localhost:5173");
  await unfold(restorer.page, "Lost your device?");
  await restorer.page.setInputFiles('input[aria-label="Backup file"]', backupPath);
  await restorer.page.fill('input[placeholder="Backup passphrase"]', "backup-passphrase");
  await restorer.page.click("text=Restore from Backup");
  await restorer.page.waitForSelector('[role="alert"]', { timeout: 15000 });
  check("an instance's page refuses a backup from another server", (await text(restorer.page, '[role="alert"]')).includes(API) && (await restorer.page.locator('[data-testid="account-id"]').count()) === 0, await text(restorer.page, '[role="alert"]'));

  // 6. The same build served by another host (a published page) says who serves it.
  const hosted = await (await browser.newContext()).newPage();
  await hosted.route("http://pages.example/**", async (route) => {
    const url = new URL(route.request().url());
    route.fulfill({ response: await route.fetch({ url: `http://localhost:5174${url.pathname}` }) });
  });
  await hosted.goto("http://pages.example/");
  await hosted.waitForSelector('[data-testid="hosted-notice"]', { timeout: 10000 });
  check("a published copy warns that its host could change the app", (await text(hosted, '[data-testid="hosted-notice"]')).includes("pages.example"));
  check("and still requires a server", await hosted.locator("button", { hasText: "Create Account" }).isDisabled());
} finally {
  await browser.close();
  preview.kill();
}
process.exit(checks.some((ok) => !ok) ? 1 : 0);
