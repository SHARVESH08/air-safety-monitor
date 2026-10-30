import { sameOrigin } from "../../../lib/origin.mjs";
import { runDemo } from "../../../lib/demo.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin demo request rejected." }, { status: 403 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing demo request." }, { status: 400 });
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); return Response.json({ error: "Demo request too large." }, { status: 413 }); }
    chunks.push(Buffer.from(value));
  }
  try {
    const result = runDemo(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return Response.json(result, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error.message || "Invalid demo request." }, { status: 400 }); }
}
