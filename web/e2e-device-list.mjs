import { chromium } from "playwright";

// Pure chain rules of the signed device list (src/crypto/deviceList.ts), run in a page against
// the real wasm. Dev server only (imports source modules, like e2e-typing-signal).
const checks = [];
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` (${detail ?? ""})`}`);
  checks.push(ok);
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("pageerror", e));
await page.goto("http://localhost:5173");

const results = await page.evaluate(async () => {
  const dl = await import("/src/crypto/deviceList.ts");
  const id = await import("/src/crypto/identity.ts");
  const out = {};
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const ACCOUNT = uuid(1);
  const mk = async (n) => {
    const b = await id.generateIdentity(1);
    return { n, deviceId: uuid(100 + n), priv: b.identity_private_key, entry: { deviceId: uuid(100 + n), identityKey: Uint8Array.from(b.identity_public_key) } };
  };
  const [A, B, X] = [await mk(1), await mk(2), await mk(4)];
  const err = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message ?? e); } };

  // signed statement on top of a state; `over` overrides fields, `signer` is who signs.
  const next = async (state, devices, signer, over = {}) => {
    const st = { accountId: state ? state.accountId : ACCOUNT, version: state ? state.version + 1 : 1, prevHead: state ? state.head : new Uint8Array(32), signerDeviceId: signer.deviceId, devices: devices.map((d) => d.entry), ...over };
    return dl.signStatement(st, signer.priv);
  };

  const g = await next(null, [A], A);
  const s1 = await dl.verifyChain([g]);
  out.genesis = s1.version === 1 && s1.devices.length === 1;

  const add = await next(s1, [A, B], A);
  const s2 = await dl.verifyChain([add], s1);
  const rem = await next(s2, [A], A);
  const s3 = await dl.verifyChain([rem], s2);
  out.chain = s3.version === 3 && s3.devices.length === 1;
  out.fromGenesis = (await dl.verifyChain([g, add, rem])).version === 3;
  out.emptyKeepsPin = (await dl.verifyChain([], s3)).version === 3;
  out.selfRemoval = (await err(async () => dl.verifyChain([await next(s2, [B], A)], s2))) === null;

  out.forgedSigner = await err(async () => dl.verifyChain([await next(s1, [A, X], X)], s1));
  out.removedCannotSign = await err(async () => dl.verifyChain([await next(s3, [A, B], B)], s3));
  out.wrongPrevHead = await err(async () => dl.verifyChain([await next(s1, [A, B], A, { prevHead: new Uint8Array(32).fill(7) })], s1));
  out.rollback = await err(async () => dl.verifyChain([add], s3));
  out.skip = await err(async () => dl.verifyChain([await next(s1, [A, B], A, { version: 3 })], s1));
  out.foreignAccount = await err(async () => dl.verifyChain([await next(s1, [A, B], A, { accountId: uuid(2) })], s1));
  out.keySwap = await err(async () => dl.verifyChain([await next(s2, [A, { entry: { deviceId: B.deviceId, identityKey: X.entry.identityKey } }], A)], s2));
  out.duplicate = await err(async () => dl.verifyChain([await next(s1, [A, A], A)], s1));
  out.genesisTwoDevices = await err(async () => dl.verifyChain([await next(null, [A, B], A)]));
  out.genesisSignedByOther = await err(async () => dl.verifyChain([await next(null, [A], X)]));
  out.genesisNonzeroPrev = await err(async () => dl.verifyChain([await next(null, [A], A, { prevHead: new Uint8Array(32).fill(1) })]));

  const tampered = { bytes: add.bytes.slice(), signature: add.signature };
  tampered.bytes[tampered.bytes.length - 3] ^= 1;
  out.tamperedBytes = await err(async () => dl.verifyChain([tampered], s1));
  out.badSignature = await err(async () => dl.verifyChain([{ bytes: add.bytes, signature: add.signature.slice().fill(0) }], s1));
  out.noPrefix = await err(async () => dl.decodeStatement(add.bytes.slice(1)));
  out.trailing = await err(async () => dl.decodeStatement(Uint8Array.from([...add.bytes, 0])));
  out.truncated = await err(async () => dl.decodeStatement(add.bytes.slice(0, add.bytes.length - 1)));
  out.noPinNoStatements = await err(async () => dl.verifyChain([]));

  // The same key signing request-style text cannot pass as a statement.
  const text = new TextEncoder().encode("GET\n/v1/messages\n123\n" + "0".repeat(64));
  const sig = await id.signWithIdentity(A.priv, text);
  out.otherDomain = await err(async () => dl.verifyChain([{ bytes: text, signature: sig }]));
  return out;
});

check("genesis verifies", results.genesis);
check("add then remove verifies, from a pin and from genesis", results.chain && results.fromGenesis);
check("nothing new keeps the pin", results.emptyKeepsPin);
check("a device may remove itself", results.selfRemoval);
for (const [k, label, why] of [
  ["forgedSigner", "a signer outside the previous list is refused", "signer was not"],
  ["removedCannotSign", "a removed device cannot sign the next statement", "signer was not"],
  ["wrongPrevHead", "a broken link to the previous head is refused", "does not follow"],
  ["rollback", "an older statement on a newer pin is refused", "unexpected version"],
  ["skip", "a skipped version is refused", "unexpected version"],
  ["foreignAccount", "a statement of another account is refused", "another account"],
  ["keySwap", "a changed key for a staying device is refused", "key cannot change"],
  ["duplicate", "a duplicate device is refused", "duplicate"],
  ["genesisTwoDevices", "a genesis with two devices is refused", "exactly one"],
  ["genesisSignedByOther", "a genesis not signed by its own device is refused", "signer was not"],
  ["genesisNonzeroPrev", "a genesis with a previous head is refused", "empty previous head"],
  ["tamperedBytes", "tampered bytes are refused", "signature does not verify"],
  ["badSignature", "a bad signature is refused", "signature does not verify"],
  ["noPrefix", "bytes without the prefix are refused", "not a device list"],
  ["trailing", "trailing bytes are refused", "trailing"],
  ["truncated", "truncated bytes are refused", "truncated"],
  ["noPinNoStatements", "nothing to verify and no pin is an error", "no statements"],
  ["otherDomain", "a signature over request-style text is not a statement", "not a device list"],
]) check(label, typeof results[k] === "string" && results[k].includes(why), String(results[k]));

await browser.close();
process.exit(checks.some((ok) => !ok) ? 1 : 0);
