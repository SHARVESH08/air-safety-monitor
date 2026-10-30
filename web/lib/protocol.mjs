import { sha256, stringToHex, hexToString } from "viem";
export const CHAIN_ID = 80002;
export const CHAIN_HEX = "0x13882";
export const EXPLORER = "https://amoy.polygonscan.com";
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const levels = ["SAFE", "CAUTION", "DANGER"];
export function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 60) throw new Error("Provide 1–60 readings.");
  return rows.map((r) => {
    if (!r || !Number.isSafeInteger(r.t) || r.t < 0 || typeof r.confined !== "boolean" || !levels.includes(r.level)) throw new Error("Invalid reading metadata.");
    for (const field of ["gas", "o2", "lux", "c", "hpa"]) {
      if (typeof r[field] !== "number" || !Number.isFinite(r[field]) || Math.abs(r[field]) > 1e6) throw new Error("Invalid reading value.");
    }
    return { t: r.t, gas: r.gas, o2: r.o2, lux: r.lux, confined: r.confined, c: r.c, hpa: r.hpa, level: r.level };
  });
}
export function hashRows(rows) { return sha256(stringToHex(JSON.stringify(normalizeRows(rows)))); }
export function buildPayload(rows, kind = "batch", timestamp = Math.floor(Date.now() / 1000)) {
  rows = normalizeRows(rows);
  if (!["batch", "alert"].includes(kind)) throw new Error("Invalid anchor kind.");
  const level = rows.some(r => r.level === "DANGER") ? "DANGER" : rows.some(r => r.level === "CAUTION") ? "CAUTION" : "SAFE";
  return { v: 2, src: "sim", dev: "AQ-01", kind, b: Math.floor(timestamp / 30), n: rows.length, lvl: level, h: hashRows(rows), ts: timestamp };
}
export function encodePayload(payload) { return stringToHex(JSON.stringify(payload)); }
export function decodePayload(input) {
  try {
    if (input.length > 4096) throw new Error();
    const p = JSON.parse(hexToString(input));
    if (p.v !== 2 || p.src !== "sim" || p.dev !== "AQ-01" || !["batch", "alert"].includes(p.kind) || !HASH_RE.test(p.h) ||
      !Number.isSafeInteger(p.ts) || p.ts < 0 || p.b !== Math.floor(p.ts / 30) || !Number.isInteger(p.n) || p.n < 1 || p.n > 60 || !levels.includes(p.lvl)) throw new Error();
    return p;
  } catch { throw new Error("Transaction does not contain a valid AirSafe v2 anchor."); }
}
export function inspectEvidence(entry, tx, receipt, block, allowedWallets) {
  if (!allowedWallets.includes(tx.from?.toLowerCase())) return { status: "unauthorized", message: "Transaction signer is not an approved monitoring wallet." };
  if (receipt.status !== "success") return { status: "reverted", message: "Anchor transaction reverted." };
  if (entry.blockHash && entry.blockHash !== receipt.blockHash) return { status: "reorg", message: "Previously observed receipt block changed; inspect a possible chain reorganization." };
  if (block.hash !== receipt.blockHash || tx.blockHash !== receipt.blockHash) return { status: "reorg", message: "Receipt is not in the reported canonical block." };
  try {
    const p = decodePayload(tx.input);
    const expected = buildPayload(entry.rows, p.kind, p.ts);
    if (tx.hash.toLowerCase() !== entry.hash.toLowerCase() || tx.to?.toLowerCase() !== tx.from.toLowerCase() || tx.value !== 0n ||
      (tx.chainId !== undefined && Number(tx.chainId) !== CHAIN_ID) ||
      (entry.signer && tx.from.toLowerCase() !== entry.signer.toLowerCase()) ||
      (entry.payload && encodePayload(entry.payload) !== encodePayload(p)) ||
      encodePayload(expected) !== tx.input.toLowerCase() || Math.abs(Number(block.timestamp) - p.ts) > 600) {
      return { status: "mismatch", message: "Saved readings or metadata do not match the signed on-chain evidence." };
    }
    return { status: "verified", message: "Reading hash, signer, payload and canonical receipt match.", payload: p };
  } catch (e) { return { status: "mismatch", message: e.message }; }
}
