import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildPayload, encodePayload } from "../lib/protocol.mjs";
const signer = "0x1111111111111111111111111111111111111111";
const hash = "0x" + "ab".repeat(32), blockHash = "0x" + "cd".repeat(32);
const rows = [{ t: 1800000000, gas: 505, o2: 20.9, lux: 312, confined: false, c: 30.4, hpa: 1008.6, level: "SAFE" }];
let offline = false, missing = false, wrongSigner = false, changedBlock = false;
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const rpc = JSON.parse(body);
  if (offline) { res.writeHead(503); return res.end("offline"); }
  const currentHash = changedBlock ? "0x" + "ef".repeat(32) : blockHash;
  let result;
  switch (rpc.method) {
    case "eth_chainId": result = "0x13882"; break;
    case "eth_blockNumber": result = "0x65"; break;
    case "eth_getTransactionByHash": result = { hash, from: wrongSigner ? "0x2222222222222222222222222222222222222222" : signer, to: signer, input: encodePayload(buildPayload(rows, "batch", 1800000000)), value: "0x0", chainId: "0x13882", blockHash: currentHash, blockNumber: "0x64", gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: hash, s: hash }; break;
    case "eth_getTransactionReceipt": result = missing ? null : { transactionHash: hash, transactionIndex: "0x0", from: signer, to: signer, blockHash: currentHash, blockNumber: "0x64", contractAddress: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x0" }; break;
    case "eth_getBlockByNumber": result = { hash: currentHash, number: "0x64", timestamp: "0x6b49d201", parentHash: blockHash, transactions: [], gasLimit: "0x100000", gasUsed: "0x5208", baseFeePerGas: "0x1", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x100", miner: signer, nonce: "0x0000000000000000", logsBloom: "0x" + "00".repeat(256), receiptsRoot: hash, stateRoot: hash, transactionsRoot: hash, sha3Uncles: hash, uncles: [] }; break;
    default: throw new Error(`Unexpected RPC method ${rpc.method}`);
  }
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
process.env.AMOY_RPC_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.ANCHOR_ALLOWED_WALLETS = signer;
for (const key of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[key];
const { POST, GET } = await import("../app/api/anchor/route.js");
const { invalidateMonitor } = await import("../lib/chain.js");
after(() => mock.close());
function request(body, headers = {}) { return new Request("http://localhost/api/anchor", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); }
async function snapshot() { invalidateMonitor(); const response = await GET(); assert.equal(response.status, 200); return response.json(); }
test("API rejects old server-signing requests", async () => assert.equal((await POST(request({ kind: "batch", dataHash: hash }))).status, 400));
test("API rejects cross-origin requests and large bodies", async () => {
  assert.equal((await POST(request({ hash, rows }, { origin: "https://elsewhere.invalid" }))).status, 403);
  assert.equal((await POST(request({ hash, rows, padding: "x".repeat(66000) }))).status, 413);
});
test("API registers confirmed approved proof, deduplicates and verifies it", async () => {
  for (let i = 0; i < 2; i++) { const response = await POST(request({ hash, rows })); assert.equal(response.status, 200, JSON.stringify(await response.json())); }
  const data = await snapshot(); assert.equal(data.txs.length, 1); assert.equal(data.txs[0].verification, "verified"); assert.equal(data.txs[0].confirmations, 2);
});
test("API rejects changed evidence and records a deduplicated alert", async () => {
  for (let i = 0; i < 2; i++) assert.equal((await POST(request({ hash, rows: [{ ...rows[0], gas: 999 }] }))).status, 403);
  const data = await snapshot(); assert.equal(data.alerts.filter(a => a.code === "MISMATCH").length, 1); assert.equal(data.txs[0].verification, "verified");
});
test("API rejects unapproved transaction signer", async () => { wrongSigner = true; assert.equal((await POST(request({ hash, rows }))).status, 403); wrongSigner = false; assert.ok((await snapshot()).alerts.some(a => a.code === "UNAUTHORIZED")); });
test("monitor detects modification in saved rows", async () => {
  globalThis.__airSecurity.entries[0].rows[0].gas = 700;
  const data = await snapshot(); assert.equal(data.txs[0].verification, "mismatch");
  globalThis.__airSecurity.entries[0].rows[0].gas = 505;
});
test("monitor detects receipt reorganization", async () => { changedBlock = true; assert.equal((await snapshot()).txs[0].verification, "reorg"); changedBlock = false; });
test("missing receipt is unknown, never verified", async () => { missing = true; assert.equal((await snapshot()).txs[0].verification, "missing"); assert.equal((await POST(request({ hash, rows }))).status, 409); missing = false; });
test("RPC outage generates warning and recovers", async () => {
  offline = true; const down = await snapshot(); assert.equal(down.rpc, "unavailable"); assert.equal(down.txs[0].verification, "unavailable"); assert.ok(down.alerts.some(a => a.code === "RPC_UNAVAILABLE"));
  offline = false; assert.equal((await snapshot()).txs[0].verification, "verified");
});
test("missing allowlist blocks registration", async () => { process.env.ANCHOR_ALLOWED_WALLETS = ""; assert.equal((await POST(request({ hash, rows }))).status, 503); process.env.ANCHOR_ALLOWED_WALLETS = signer; });
