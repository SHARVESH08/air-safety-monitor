import { sameOrigin } from "../../../lib/origin.mjs";
import { register, recent, invalidateMonitor } from "../../../lib/chain.js";
import { admitRegistration } from "../../../lib/security-store.js";
import { HASH_RE, normalizeRows } from "../../../lib/protocol.mjs";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try { return Response.json(await recent(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Monitoring storage or configuration unavailable." }, { status: 503 }); }
}
export async function POST(request) {
  try {
    if (!sameOrigin(request)) return Response.json({ error: "Cross-origin registration rejected." }, { status: 403 });
    if (Number(request.headers.get("content-length")) > 65536) return Response.json({ error: "Request too large." }, { status: 413 });
    const reader = request.body?.getReader();
    const chunks = []; let size = 0;
    if (!reader) return Response.json({ error: "Missing evidence." }, { status: 400 });
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); return Response.json({ error: "Request too large." }, { status: 413 }); }
      chunks.push(Buffer.from(value));
    }
    let body, rows;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!HASH_RE.test(body?.hash ?? "")) throw new Error("Invalid transaction hash.");
      rows = normalizeRows(body.rows);
    } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
    if (!await admitRegistration()) return Response.json({ error: "Registration limit reached. Retry in one minute." }, { status: 429 });
    const result = await register(body.hash.toLowerCase(), rows);
    invalidateMonitor();
    return Response.json(result, { status: result.status });
  } catch { return Response.json({ error: "Verification service unavailable. Retry registration later." }, { status: 503 }); }
}
