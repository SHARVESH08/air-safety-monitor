import { redis } from "./store.js";
const state = globalThis.__airSecurity ??= { entries: [], alerts: [], dedup: new Map(), rate: { window: 0, count: 0 } };
const parse = value => typeof value === "string" ? JSON.parse(value) : value;
export async function entries() {
  return redis ? (await redis.lrange("airsafe:v2:entries", 0, 19)).map(parse) : state.entries;
}
export async function saveEntry(entry) {
  if (redis) {
    // Single atomic Lua operation: deduplicate and retain only the latest 20 proofs.
    await redis.eval(`local items = redis.call('LRANGE', KEYS[1], 0, -1)
      for _, item in ipairs(items) do
        if cjson.decode(item).hash == ARGV[1] then return 0 end
      end
      redis.call('LPUSH', KEYS[1], ARGV[2])
      redis.call('LTRIM', KEYS[1], 0, 19)
      return 1`, ["airsafe:v2:entries"], [entry.hash, JSON.stringify(entry)]);
  } else if (!state.entries.some(e => e.hash === entry.hash)) state.entries = [entry, ...state.entries].slice(0, 20);
}
export async function addAlert(code, message, hash = null, severity = "critical") {
  const key = `${code}:${hash ?? "system"}`;
  const now = Date.now();
  if (redis) {
    if (!await redis.set(`airsafe:v2:dedup:${key}`, 1, { nx: true, ex: 300 })) return;
  } else {
    for (const [k, expiry] of state.dedup) if (expiry <= now) state.dedup.delete(k);
    if (state.dedup.has(key)) return;
    state.dedup.set(key, now + 300000);
  }
  const alert = { id: `${now}-${code}-${hash ?? "system"}`, code, message, hash, severity, at: now };
  if (redis) await redis.pipeline().lpush("airsafe:v2:alerts", JSON.stringify(alert)).ltrim("airsafe:v2:alerts", 0, 29).exec();
  else state.alerts = [alert, ...state.alerts].slice(0, 30);
}
export async function alerts() { return redis ? (await redis.lrange("airsafe:v2:alerts", 0, 29)).map(parse) : state.alerts; }
export async function admitRegistration() {
  const window = Math.floor(Date.now() / 60000);
  if (redis) {
    const key = `airsafe:v2:rate:${window}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 120);
    return n <= 30;
  }
  if (state.rate.window !== window) state.rate = { window, count: 0 };
  return ++state.rate.count <= 30;
}
