import test from "node:test";
import assert from "node:assert/strict";
import { runSandbox } from "../lib/sandbox.mjs";
import { POST } from "../app/api/sandbox/route.js";
const rows = () => [{ t: 1800000000, gas: 505, o2: 20.9, lux: 312, confined: false, c: 30.4, hpa: 1008.6, level: "SAFE" }];
test("sandbox accepts unchanged sample without locking", () => {
  const start = runSandbox({ action: "start", rows: rows() });
  const result = runSandbox({ action: "write", session: start.session, gas: 505 });
  assert.equal(result.status, 200); assert.equal(result.locked, false); assert.equal(result.originalHash, start.originalHash);
});
test("tampered sample is rejected, original remains unchanged, session is locked", () => {
  const start = runSandbox({ action: "start", rows: rows() });
  const result = runSandbox({ action: "write", session: start.session, gas: 999 });
  assert.equal(result.status, 403); assert.equal(result.blocked, true); assert.equal(result.locked, true);
  assert.equal(result.originalGas, 505); assert.equal(result.attemptedGas, 999);
  assert.equal(result.originalHash, start.originalHash); assert.notEqual(result.attemptedHash, start.originalHash);
  const retry = runSandbox({ action: "write", session: start.session, gas: 505 });
  assert.equal(retry.status, 423); assert.equal(retry.originalGas, 505); assert.equal(retry.events.at(-1).title, "Further write denied");
});
test("restriction applies only to its isolated sandbox session", () => {
  const first = runSandbox({ action: "start", rows: rows() }); const second = runSandbox({ action: "start", rows: rows() });
  runSandbox({ action: "write", session: first.session, gas: 999 });
  assert.equal(runSandbox({ action: "write", session: second.session, gas: 505 }).status, 200);
});
test("invalid values do not lock session; reset revokes the session token", () => {
  const start = runSandbox({ action: "start", rows: rows() });
  assert.equal(runSandbox({ action: "write", session: start.session, gas: -1 }).status, 400);
  assert.equal(runSandbox({ action: "write", session: start.session, gas: 505 }).locked, false);
  assert.equal(runSandbox({ action: "reset", session: start.session }).status, 200);
  assert.equal(runSandbox({ action: "write", session: start.session, gas: 999 }).status, 404);
});
test("sandbox sessions expire and event history stays bounded", () => {
  const at = Date.now(); const start = runSandbox({ action: "start", rows: rows() }, at);
  runSandbox({ action: "write", session: start.session, gas: 999 }, at + 1);
  let retry; for (let n = 0; n < 20; n++) retry = runSandbox({ action: "write", session: start.session, gas: 999 }, at + 2);
  assert.equal(retry.events.length, 10);
  assert.equal(runSandbox({ action: "write", session: start.session, gas: 999 }, at + 900001).status, 404);
});
const request = body => new Request("http://localhost/api/sandbox", { method: "POST", body: JSON.stringify(body) });
test("sandbox API enforces rejection and lock with real HTTP status codes", async () => {
  const start = await (await POST(request({ action: "start", rows: rows() }))).json();
  const blocked = await POST(request({ action: "write", session: start.session, gas: 999 }));
  assert.equal(blocked.status, 403); assert.equal((await blocked.json()).sandbox, true);
  assert.equal((await POST(request({ action: "write", session: start.session, gas: 505 }))).status, 423);
});
test("sandbox API rejects oversized and malformed requests", async () => {
  assert.equal((await POST(request({ padding: "x".repeat(17000) }))).status, 413);
  assert.equal((await POST(new Request("http://localhost/api/sandbox", { method: "POST", body: "not-json" }))).status, 400);
});
test("same-site browser request works when Next exposes internal hostname", async () => {
  const response = await POST(new Request("http://localhost:3002/api/sandbox", { method: "POST", headers: { host: "127.0.0.1:3002", origin: "http://127.0.0.1:3002" }, body: JSON.stringify({ action: "start", rows: rows() }) }));
  assert.equal(response.status, 200);
  const crossSite = await POST(new Request("http://localhost:3002/api/sandbox", { method: "POST", headers: { host: "127.0.0.1:3002", origin: "https://elsewhere.invalid" }, body: "{}" }));
  assert.equal(crossSite.status, 403);
});
test("monitoring interface reads same session restriction without adding events", () => {
  const start = runSandbox({ action: "start", rows: rows() });
  const before = runSandbox({ action: "status", session: start.session });
  assert.equal(before.locked, false); assert.equal(before.events.length, 1);
  runSandbox({ action: "write", session: start.session, gas: 999 });
  const after = runSandbox({ action: "status", session: start.session });
  assert.equal(after.locked, true); assert.equal(after.originalGas, 505); assert.equal(after.attemptedGas, 999);
  assert.equal(runSandbox({ action: "status", session: start.session }).events.length, after.events.length);
});
