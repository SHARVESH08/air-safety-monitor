import { createPublicClient, http, isAddress } from "viem";
import { polygonAmoy } from "viem/chains";
import { redis } from "./store.js";
import { entries, saveEntry, alerts, addAlert } from "./security-store.js";
import { CHAIN_ID, inspectEvidence } from "./protocol.mjs";
const client = createPublicClient({ chain: polygonAmoy, transport: http(process.env.AMOY_RPC_URL || undefined, { timeout: 8000, retryCount: 0 }) });
export function allowedWallets() {
  const configured = (process.env.ANCHOR_ALLOWED_WALLETS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (configured.some(x => !isAddress(x))) throw new Error("ANCHOR_ALLOWED_WALLETS contains an invalid address.");
  return configured.map(x => x.toLowerCase());
}
async function evidence(hash) {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return { tx, receipt, block };
}
function unavailable(e) { return /Transaction(NotFound|ReceiptNotFound)Error/.test(e.name) ? "pending" : "unavailable"; }
export async function register(hash, rows) {
  const allowed = allowedWallets();
  if (!allowed.length) return { error: "Configure ANCHOR_ALLOWED_WALLETS on the server first.", status: 503 };
  let proof;
  try {
    if (await client.getChainId() !== CHAIN_ID) throw new Error("Wrong RPC chain");
    proof = await evidence(hash);
  } catch (e) {
    return { error: unavailable(e) === "pending" ? "Transaction not confirmed yet. Retry registration after mining." : "RPC verification unavailable. Retry without sending another transaction.", status: unavailable(e) === "pending" ? 409 : 503 };
  }
  const result = inspectEvidence({ hash, rows }, proof.tx, proof.receipt, proof.block, allowed);
  if (result.status !== "verified") {
    await addAlert(result.status.toUpperCase(), result.message, hash);
    return { error: result.message, status: 403 };
  }
  const entry = { hash, rows, payload: result.payload, signer: proof.tx.from, blockHash: proof.receipt.blockHash, sentAt: Date.now() };
  await saveEntry(entry);
  return { hash, status: 200 };
}
async function monitor() {
  const allowed = allowedWallets();
  const saved = await entries();
  let latest = null;
  let rpc = "online";
  try {
    if (await client.getChainId() !== CHAIN_ID) throw new Error("RPC chain mismatch");
    latest = await client.getBlockNumber();
  } catch { rpc = "unavailable"; }
  if (rpc !== "online") await addAlert("RPC_UNAVAILABLE", "Blockchain verification is unavailable. Integrity is unknown until the RPC recovers.", null, "warning");
  const txs = await Promise.all(saved.map(async entry => {
    if (rpc !== "online") return { ...entry, verification: "unavailable", message: "RPC unavailable; integrity unknown." };
    try {
      const { tx, receipt, block } = await evidence(entry.hash);
      const result = inspectEvidence(entry, tx, receipt, block, allowed);
      if (result.status !== "verified") await addAlert(result.status.toUpperCase(), result.message, entry.hash);
      return { ...entry, verification: result.status, message: result.message, block: Number(receipt.blockNumber), confirmations: Math.max(0, Number(latest - receipt.blockNumber + 1n)), fee: Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18 };
    } catch (e) {
      const status = unavailable(e);
      await addAlert(status === "pending" ? "MISSING_RECEIPT" : "RPC_UNAVAILABLE", status === "pending" ? "Previously confirmed transaction is no longer available from this RPC. Inspect possible reorganization or provider inconsistency." : "Could not reverify an anchor; integrity is unknown.", entry.hash, "warning");
      return { ...entry, verification: status === "pending" ? "missing" : status, message: "Previously saved evidence could not be verified." };
    }
  }));
  return { txs, alerts: await alerts(), allowedWallets: allowed, storage: redis ? "Redis" : "temporary memory", rpc, latestBlock: latest === null ? null : Number(latest), checkedAt: Date.now(), chainId: CHAIN_ID };
}
const cache = globalThis.__airMonitor ??= { promise: null, expires: 0 };
export async function recent() {
  if (!cache.promise || Date.now() > cache.expires) {
    cache.expires = Date.now() + 10000;
    cache.promise = monitor().catch(e => { cache.expires = 0; throw e; });
  }
  return cache.promise;
}
export function invalidateMonitor() { cache.expires = 0; }
