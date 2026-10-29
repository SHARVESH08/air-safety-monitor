// SIMULATOR: GET = recent testnet transactions, POST = anchor a hash of simulated readings.
import { anchor, recent } from "../../../lib/chain";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await recent(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { kind, batch, dataHash, level, count } = body;
  if (!["batch", "alert"].includes(kind) || !/^0x[0-9a-f]{64}$/.test(dataHash ?? "")) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const result = await anchor({ kind, batch: Number(batch) || 0, dataHash, level: String(level).slice(0, 8), count: Number(count) || 0 });
  return Response.json(result, { status: result.error ? 503 : 200 });
}
