import { chromium } from "playwright";
import { startChat } from "./ui-steps.mjs";

// A call whose two devices never find a network path (simulated: neither side uses the other's
// candidates) must end as "Call failed" on both sides instead of "Connecting..." forever.
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

async function createAccount(label) {
  const context = await browser.newContext();
  await context.grantPermissions(["camera", "microphone"]);
  // No path between the two: a remote candidate is accepted and thrown away.
  await context.addInitScript(() => {
    RTCPeerConnection.prototype.addIceCandidate = () => Promise.resolve();
  });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { page, logs, id: (await page.textContent('[data-testid="account-id"]')).trim() };
}

try {
  const alice = await createAccount("alice");
  const bob = await createAccount("bob");
  await startChat(alice.page, bob.id);
  await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
  await startChat(bob.page, alice.id);
  await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });

  await alice.page.click('[aria-label="Video call"]');
  await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
  await bob.page.click('[data-testid="incoming-call-banner"] button:has-text("Accept")');
  await alice.page.waitForSelector('[data-testid="call-status-label"]:has-text("Connecting")', { timeout: 15000 });

  const box = await alice.page.locator('[data-testid="local-video"]').boundingBox();
  check("your own picture keeps a fixed 3:4 frame", box && Math.abs(box.height / box.width - 4 / 3) < 0.05, JSON.stringify(box));

  const acceptedAt = Date.now();
  await Promise.all([alice, bob].map((p) => p.page.waitForSelector('[data-testid="call-ended"]', { timeout: 40000 })));
  const seconds = (Date.now() - acceptedAt) / 1000;
  const aliceEnd = await alice.page.textContent('[data-testid="call-ended"]');
  const bobEnd = await bob.page.textContent('[data-testid="call-ended"]');
  check("a call that never connects gives up on both sides", aliceEnd.includes("Call failed") && bobEnd.includes("Call failed"), `${aliceEnd} / ${bobEnd}`);
  check("after about 20 seconds", seconds > 15 && seconds < 30, `${seconds.toFixed(1)} s`);

  check("the console shows the addresses each side offers", alice.logs.some((l) => l.startsWith("[call] local candidate: host")) && alice.logs.some((l) => l.startsWith("[call] remote candidate: host")), alice.logs.filter((l) => l.startsWith("[call]")).join(" | "));
  check("and whether a relay is configured", alice.logs.includes("[call] ICE servers: none (direct paths only)"), alice.logs.filter((l) => l.startsWith("[call]")).join(" | "));
} catch (err) {
  check("the run reached its end", false, String(err).split("\n")[0]);
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
