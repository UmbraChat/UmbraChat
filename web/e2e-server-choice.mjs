import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Needs the API on http://localhost:3000 and the dev server on :5173 (same-origin default, proxied).
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
  // 1. Same-origin default build, but a server can still be chosen.
  const alice = await newPage("http://localhost:5173");
  await alice.page.fill('[data-testid="server-input"]', API);
  await alice.page.click("text=Create Account");
  await alice.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  const aliceId = await text(alice.page, '[data-testid="account-id"]');
  check("a chosen server receives the requests directly", alice.requests.some((u) => u.startsWith(`${API}/v1/register`)), alice.requests.filter((u) => u.includes("/v1/")).join(" "));
  check("none go through this page's own origin", !alice.requests.some((u) => u.startsWith("http://localhost:5173/v1/")));

  // 2. Someone on the default (same-origin) server can talk to them: same database behind both.
  const bob = await newPage("http://localhost:5173");
  await bob.page.click("text=Create Account");
  await bob.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  await alice.page.fill('input[placeholder="Recipient account id"]', await text(bob.page, '[data-testid="account-id"]'));
  await alice.page.click("text=Start Conversation");
  await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
  await alice.page.fill('input[placeholder="Type a message..."]', "across origins");
  await alice.page.click("text=Send");
  await bob.page.fill('input[placeholder="Recipient account id"]', aliceId);
  await bob.page.click("text=Start Conversation");
  await bob.page.waitForSelector('[data-testid="message-received"]:has-text("across origins")', { timeout: 20000 });
  check("messages cross between a chosen server and the default one", true);

  // 3. Unusable addresses are refused before any request.
  const bad = await newPage("http://localhost:5173");
  for (const input of ["javascript:alert(1)", "http://evil.example", "ftp://evil.example", "https://user:pw@evil.example"]) {
    await bad.page.fill('[data-testid="server-input"]', input);
    await bad.page.click("text=Create Account");
    await bad.page.waitForSelector('[data-testid="server-error"]', { timeout: 5000 });
    check(`refuses "${input}"`, true);
  }
  check("and never contacted it", !bad.requests.some((u) => u.includes("evil.example") || u.includes("/v1/register")), bad.requests.join(" "));

  // 4. Settings shows the server and warns only when the app and the server share a host.
  await alice.page.click('button[aria-label="Back to menu"]');
  await alice.page.click("text=Settings");
  await alice.page.waitForSelector('[data-testid="server-url"]', { timeout: 10000 });
  check("settings shows the chosen server", (await text(alice.page, '[data-testid="server-url"]')) === API);
  check("no same-host warning when the server is elsewhere", (await alice.page.locator('[data-testid="same-host-warning"]').count()) === 0);
  await bob.page.click('button[aria-label="Back to menu"]');
  await bob.page.click("text=Settings");
  await bob.page.waitForSelector('[data-testid="server-url"]', { timeout: 10000 });
  check("same-host warning when the app and server share an origin", (await bob.page.locator('[data-testid="same-host-warning"]').count()) === 1);

  // 5. The client built without a same-origin default must be told the server.
  const generic = await newPage("http://localhost:5174");
  const violations = [];
  generic.page.on("console", (m) => m.text().includes("Content Security Policy") && violations.push(m.text()));
  check("the build carries its own Content-Security-Policy", (await generic.page.content()).includes('http-equiv="Content-Security-Policy"'));
  await generic.page.waitForSelector('[data-testid="server-input"]', { timeout: 10000 });
  check("with no server chosen, creating an account is not possible", await generic.page.locator("button", { hasText: "Create Account" }).isDisabled());
  await generic.page.fill('[data-testid="server-input"]', API);
  await generic.page.click("text=Create Account");
  await generic.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  check("once a server is entered it works", true);
  check("and nothing it needs is blocked by that policy", violations.length === 0, violations.join(" | "));
  check("and never calls its own host's API", !generic.requests.some((u) => u.startsWith("http://localhost:5174/v1/")), generic.requests.filter((u) => u.includes("/v1/")).join(" "));
} finally {
  await browser.close();
  preview.kill();
}
process.exit(checks.some((ok) => !ok) ? 1 : 0);
