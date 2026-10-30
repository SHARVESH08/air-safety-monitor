import { randomUUID } from "node:crypto";
import { hashRows, normalizeRows } from "./protocol.mjs";

// Isolated, expiring sandbox sessions. No production evidence or wallet policy is changed.
const sessions = globalThis.__airSandboxSessions ??= new Map();
const TTL = 15 * 60 * 1000;
function view(session) {
  return { sandbox: true, session: session.id, locked: session.locked, originalGas: session.rows[0].gas, originalHash: session.hash, attemptedGas: session.attemptedGas ?? null, attemptedHash: session.attemptedHash ?? null, events: session.events };
}
export function runSandbox(body, now = Date.now()) {
  for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  if (body?.action === "start") {
    if (sessions.size >= 100) return { status: 429, error: "Sandbox is busy. Try again after a session expires." };
    const rows = normalizeRows(body.rows);
    const session = { id: randomUUID(), rows, hash: hashRows(rows), locked: false, expires: now + TTL, events: [{ at: now, title: "Baseline captured", detail: "Original sample and SHA-256 stored in the sandbox." }] };
    sessions.set(session.id, session);
    return { status: 200, ...view(session) };
  }
  const session = sessions.get(body?.session);
  if (!session) return { status: 404, error: "Session expired or unavailable. Start a new session." };
  if (body.action === "status") return { status: 200, ...view(session) };
  if (body.action === "reset") { sessions.delete(session.id); return { status: 200, sandbox: true, reset: true }; }
  if (body.action !== "write") return { status: 400, error: "Unknown sandbox action." };
  if (session.locked) {
    session.events = [...session.events, { at: now, title: "Further write denied", detail: "HTTP 423: this sandbox writer session is restricted." }].slice(-10);
    return { status: 423, blocked: true, ...view(session) };
  }
  if (typeof body.gas !== "number" || !Number.isFinite(body.gas) || body.gas < 0 || body.gas > 1000000) return { status: 400, error: "Use a gas reading between 0 and 1000000 ppm." };
  const candidate = session.rows.map((row, i) => i === 0 ? { ...row, gas: body.gas } : { ...row });
  const candidateHash = hashRows(candidate);
  if (candidateHash !== session.hash) {
    session.locked = true;
    session.attemptedGas = body.gas;
    session.attemptedHash = candidateHash;
    session.events.push({ at: now, title: "Modified sample submitted", detail: `Writer attempted ${session.rows[0].gas} → ${body.gas} ppm.` }, { at: now, title: "Hash mismatch detected", detail: "Recomputed SHA-256 differs from the captured baseline." }, { at: now, title: "Write rejected; session restricted", detail: "HTTP 403. Original sample preserved. Further writes from this sandbox session will be denied." });
    return { status: 403, blocked: true, ...view(session) };
  }
  session.events.push({ at: now, title: "Integrity check passed", detail: "Unchanged sample matches the baseline; no restriction applied." });
  session.events = session.events.slice(-10);
  return { status: 200, blocked: false, ...view(session) };
}
