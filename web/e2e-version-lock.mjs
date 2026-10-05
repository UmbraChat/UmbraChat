import { chromium } from "playwright";

// Strict version lock between the app and the server. The server is faked per scenario by
// rewriting the version header of its real responses.
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const browser = await chromium.launch();

async function newPage(announce) {
  const page = await (await browser.newContext()).newPage();
  const seen = { urls: [], sentVersions: new Set() };
  page.on("request", (r) => {
    if (r.url().includes("/v1/")) {
      seen.urls.push(r.url());
      seen.sentVersions.add(r.headers()["x-umbra-protocol"]);
    }
  });
  // announce.value: undefined = leave the server's own header, null = remove it, string = replace it.
  await page.route("**/v1/**", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if (announce.value === null) delete headers["x-umbra-protocol"];
    else if (announce.value !== undefined) headers["x-umbra-protocol"] = announce.value;
    await route.fulfill({ response, headers });
  });
  await page.goto("http://localhost:5173");
  return { page, seen };
}

// 1. Same version everywhere: works, and every request declares the version.
const ok = { value: undefined };
const alice = await newPage(ok);
await alice.page.click("text=Create Account");
await alice.page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
check("an app and a server on the same version work", true);
check("every request declares exactly one version, the app's", alice.seen.sentVersions.size === 1 && alice.seen.sentVersions.has("2"), [...alice.seen.sentVersions].join(","));

// 2. The server changes version while the app is open: it stops, nothing keeps working.
ok.value = "3";
await alice.page.waitForSelector('[data-testid="version-mismatch"]', { timeout: 15000 });
check("a server that moves to another version blocks the open app", (await alice.page.textContent('[data-testid="version-mismatch"]')).includes("Update the app"));

// 3. A newer server, an older server and something that is not UmbraChat, from a fresh start.
for (const [label, value, expected] of [
  ["a newer server", "3", "Update the app"],
  ["an older server", "0", "not updated yet"],
  ["an address that announces no version", null, "does not answer like an UmbraChat server"],
]) {
  const announce = { value };
  const fresh = await newPage(announce);
  await fresh.page.click("text=Create Account");
  await fresh.page.waitForSelector('[data-testid="version-mismatch"]', { timeout: 15000 });
  const shown = await fresh.page.textContent('[data-testid="version-mismatch"]');
  check(`${label} is refused with a clear message`, shown.includes(expected), shown);
  check(`${label} never receives an account registration`, !fresh.seen.urls.some((u) => u.includes("/v1/register")), fresh.seen.urls.join(" "));
}

await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
