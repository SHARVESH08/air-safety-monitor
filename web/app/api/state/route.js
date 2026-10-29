// SIMULATOR: remote button state. GET is polled by the dashboard, POST is called by the remote.
import { getState, applyAction } from "../../../lib/store";

export const dynamic = "force-dynamic";

const REMOTE_KEY = "8cf2c0d357";

export async function GET() {
  const state = await getState();
  return Response.json({ ...state, serverTime: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  const { action, key } = await request.json().catch(() => ({}));
  if (key !== REMOTE_KEY) return Response.json({ error: "forbidden" }, { status: 403 });

  const state = await applyAction(action);
  if (!state) return Response.json({ error: "unknown action" }, { status: 400 });
  return Response.json({ ...state, serverTime: Date.now() });
}
