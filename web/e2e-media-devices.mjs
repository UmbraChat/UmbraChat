import { chromium } from "playwright";
import { startChat, openTab } from "./ui-steps.mjs";

// Choosing the microphone and camera in Settings, and switching camera during a video call.
// Chromium's fake capture offers three cameras here; its second one is a depth camera whose frames
// cannot be sent, so the test chooses the third and switches back to the first.
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}
const errors = [];
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream=device-count=3", "--use-fake-ui-for-media-stream"] });

async function createAccount(label) {
  const context = await browser.newContext();
  await context.grantPermissions(["camera", "microphone"]);
  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(`${label}: ${err}`));
  await page.goto("http://localhost:5173");
  await page.click("text=Create Account");
  await page.waitForSelector('[data-testid="account-id"]', { timeout: 15000 });
  return { page, id: (await page.textContent('[data-testid="account-id"]')).trim() };
}

const cameraInUse = (page) => page.evaluate(() => document.querySelector('[data-testid="local-video"]')?.srcObject?.getVideoTracks()[0]?.getSettings().deviceId);
// Packets keep arriving: a remote track with nothing coming in turns "muted" after a moment.
const remoteIsPlaying = async (page) => {
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    const track = document.querySelector('[data-testid="remote-video"]')?.srcObject?.getVideoTracks()[0];
    return track?.readyState === "live" && !track.muted;
  });
};

try {
  const alice = await createAccount("alice");
  const bob = await createAccount("bob");

  await openTab(alice.page, "settings");
  // Already granted in this context, the devices are named at once; otherwise access is asked first.
  // (the list loads a moment after the section shows its button).
  const named = await alice.page.waitForSelector("select", { timeout: 3000 }).then(() => true, () => false);
  if (!named) await alice.page.click("text=Choose microphone and camera");
  await alice.page.waitForSelector("select >> nth=1", { timeout: 10000 });
  const cameraOptions = await alice.page.locator("label:has-text('Camera') select option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  check("Settings lists the cameras once access is allowed", cameraOptions.length === 3, JSON.stringify(cameraOptions));
  const chosen = cameraOptions[2];
  await alice.page.selectOption("label:has-text('Camera') select", chosen);
  check("the choice is remembered", (await alice.page.evaluate(() => JSON.parse(localStorage.getItem("umbrachat:mediaDevices")).videoId)) === chosen);

  await startChat(alice.page, bob.id);
  await alice.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
  await startChat(bob.page, alice.id);
  await bob.page.waitForSelector('input[placeholder="Type a message..."]', { timeout: 15000 });
  await alice.page.click('[aria-label="Video call"]');
  await bob.page.waitForSelector('[data-testid="incoming-call-banner"]', { timeout: 15000 });
  await bob.page.click('[data-testid="incoming-call-banner"] button:has-text("Accept")');
  await alice.page.waitForSelector('[data-testid="call-status-label"]:has-text("Connected")', { timeout: 20000 });
  check("the other side receives the picture", await remoteIsPlaying(bob.page));
  check("a call uses the chosen camera", (await cameraInUse(alice.page)) === chosen, await cameraInUse(alice.page));

  const before = await cameraInUse(alice.page);
  await alice.page.click("text=Switch camera");
  await alice.page.waitForFunction((id) => document.querySelector('[data-testid="local-video"]')?.srcObject?.getVideoTracks()[0]?.getSettings().deviceId !== id, before, { timeout: 10000 }).catch(() => {});
  check("Switch camera moves to the next camera", (await cameraInUse(alice.page)) === cameraOptions[0], await cameraInUse(alice.page));
  check("the call stays connected", (await alice.page.textContent('[data-testid="call-status-label"]')).includes("Connected"));
  check("and the other side keeps receiving a picture", await remoteIsPlaying(bob.page));
  check("the camera given up is released", await alice.page.evaluate(() => document.querySelector('[data-testid="local-video"]').srcObject.getVideoTracks().length === 1));

  await alice.page.click('[data-testid="active-call-screen"] button:has-text("Hang Up")');
  await alice.page.waitForSelector('[data-testid="call-ended"]', { timeout: 10000 });
} catch (err) {
  check("the run reached its end", false, String(err).split("\n").slice(0, 4).join(" / "));
}

check("no uncaught page error", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
