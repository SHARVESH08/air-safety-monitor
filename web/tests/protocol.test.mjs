import test from "node:test";
import assert from "node:assert/strict";
import { buildPayload, encodePayload, hashRows, inspectEvidence, normalizeRows } from "../lib/protocol.mjs";
const signer = "0x1111111111111111111111111111111111111111";
const rows = [{ t: 1800000000, gas: 505, o2: 20.9, lux: 312, confined: false, c: 30.4, hpa: 1008.6, level: "SAFE" }];
const payload = buildPayload(rows, "batch", 1800000000);
const hash = "0x" + "ab".repeat(32), blockHash = "0x" + "cd".repeat(32);
function fixture() {
  return {
    entry: { hash, rows: structuredClone(rows), payload: structuredClone(payload), signer, blockHash },
    tx: { hash, from: signer, to: signer, input: encodePayload(payload), value: 0n, chainId: 80002, blockHash },
    receipt: { status: "success", blockHash }, block: { hash: blockHash, timestamp: 1800000001n }
  };
}
function verify(f) { return inspectEvidence(f.entry, f.tx, f.receipt, f.block, [signer]); }
test("valid signed anchor matches canonical rows", () => assert.equal(verify(fixture()).status, "verified"));
test("field order does not affect canonical digest", () => assert.equal(hashRows(rows), hashRows([{ ...rows[0], gas: 505 }])));
test("modified reading triggers mismatch", () => { const f = fixture(); f.entry.rows[0].gas = 999; assert.equal(verify(f).status, "mismatch"); });
test("modified on-chain data triggers mismatch", () => { const f = fixture(); f.tx.input = encodePayload({ ...payload, h: "0x" + "00".repeat(32) }); assert.equal(verify(f).status, "mismatch"); });
test("unapproved signer is rejected", () => { const f = fixture(); f.tx.from = "0x2222222222222222222222222222222222222222"; assert.equal(verify(f).status, "unauthorized"); });
test("reverted anchor never verifies", () => { const f = fixture(); f.receipt.status = "reverted"; assert.equal(verify(f).status, "reverted"); });
test("changed receipt block raises reorganization alert", () => { const f = fixture(); f.receipt.blockHash = "0x" + "ef".repeat(32); assert.equal(verify(f).status, "reorg"); });
test("noncanonical block is rejected", () => { const f = fixture(); f.block.hash = "0x" + "ef".repeat(32); assert.equal(verify(f).status, "reorg"); });
test("wrong network is rejected", () => { const f = fixture(); f.tx.chainId = 1; assert.equal(verify(f).status, "mismatch"); });
test("nonzero transfer is rejected", () => { const f = fixture(); f.tx.value = 1n; assert.equal(verify(f).status, "mismatch"); });
test("different recipient is rejected", () => { const f = fixture(); f.tx.to = "0x2222222222222222222222222222222222222222"; assert.equal(verify(f).status, "mismatch"); });
test("modified saved metadata is rejected", () => { const f = fixture(); f.entry.payload.lvl = "DANGER"; assert.equal(verify(f).status, "mismatch"); });
test("invalid or oversized readings fail validation", () => { for (const value of [[], Array(61).fill(rows[0]), [{ ...rows[0], gas: NaN }], [{ ...rows[0], confined: 1 }], [{ ...rows[0], t: -1 }]]) assert.throws(() => normalizeRows(value)); });
test("malformed calldata is rejected", () => { const f = fixture(); f.tx.input = "0xdeadbeef"; assert.equal(verify(f).status, "mismatch"); });
test("stale payload timestamp is rejected", () => { const f = fixture(); f.block.timestamp += 601n; assert.equal(verify(f).status, "mismatch"); });
