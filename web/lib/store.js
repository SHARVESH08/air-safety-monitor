// SIMULATOR: shared state for the hidden remote buttons.
// Uses Upstash Redis when configured (Vercel), otherwise an in-memory object (local dev only).
// Every press is a single atomic command (INCR / RPUSH), so quick presses can't overwrite each other.
// Toggles are counters: an odd count means "on".
import { Redis } from "@upstash/redis";

const LIGHT = "sim:light";
const SPACE = "sim:space";
const CO2 = "sim:co2";
const CO2_KEEP = 20;

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
export const redis = url && token ? new Redis({ url, token }) : null;

const memory = globalThis.__simState ?? (globalThis.__simState = { [LIGHT]: 0, [SPACE]: 0, [CO2]: [] });

export async function getState() {
  let light, space, co2;
  if (redis) [light, space, co2] = await redis.pipeline().get(LIGHT).get(SPACE).lrange(CO2, 0, -1).exec();
  else [light, space, co2] = [memory[LIGHT], memory[SPACE], memory[CO2]];
  return { noLight: Number(light ?? 0) % 2 === 1, smallSpace: Number(space ?? 0) % 2 === 1, co2Presses: (co2 ?? []).map(Number) };
}

const ACTIONS = {
  toggleLight: () => (redis ? redis.incr(LIGHT) : memory[LIGHT]++),
  toggleSpace: () => (redis ? redis.incr(SPACE) : memory[SPACE]++),
  co2: () => {
    const now = Date.now();
    if (!redis) return (memory[CO2] = [...memory[CO2], now].slice(-CO2_KEEP));
    return redis.pipeline().rpush(CO2, now).ltrim(CO2, -CO2_KEEP, -1).exec();
  },
  reset: () => (redis ? redis.del(LIGHT, SPACE, CO2) : Object.assign(memory, { [LIGHT]: 0, [SPACE]: 0, [CO2]: [] })),
};

export async function applyAction(action) {
  if (!Object.hasOwn(ACTIONS, action)) return null;
  await ACTIONS[action]();
  return getState();
}
