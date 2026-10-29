# Air Safety Monitor — SIMULATOR

**Every reading on this site is simulated in the browser. Nothing here talks to the ESP32 or any real sensor.**

Built as a prank for friends. The "reveal" is reading this code.

- `/` — fake live dashboard (VIT Chennai location, real weather from Open-Meteo, simulated sensor values)
- `/remote-8cf2c0d357` — hidden remote with three buttons:
  - **No light** (toggle): light level drops to ~0 lux, as if the LDR is covered
  - **Small space** (toggle): ultrasonic distance drops to ~40 cm, oxygen drifts down
  - **High CO2** (per press): gas burst that rises over a few seconds and decays over ~1 min
- `/api/state` — stores the button states (Upstash Redis on Vercel, in-memory locally)
- `/api/anchor` — sends real Polygon Amoy **testnet** transactions containing the SHA-256 of each 30 s batch of
  **simulated** readings (plus an ALERT transaction on entering DANGER). The transactions are real; the data is not.
  Every payload includes `"src":"sim"`. At most one batch per 25 s. See `lib/chain.js`.
  Needs `ANCHOR_PRIVATE_KEY` (a throwaway testnet wallet) in the Vercel env, funded from an Amoy faucet.

The sensor physics live in `lib/simulator.js`.

## Run locally

```
npm install
npm run dev
```

## Deploy

Add an Upstash Redis database to the Vercel project (Storage / Marketplace). It sets
`KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`), which `lib/store.js` reads.
