# AirSafe — monitoring and MetaMask evidence

All sensor readings in this dashboard are simulated by `lib/simulator.js`; it does not receive ESP32 readings. Outdoor weather is fetched separately. The interface now labels the simulated source explicitly. This is a project prototype, not a calibrated safety system.

## Run on Windows

Use Node.js 22.9+ (Node 24 recommended).

```powershell
cd air-safety-monitor/web
npm ci
Copy-Item .env.example .env.local
# Edit .env.local: set ANCHOR_ALLOWED_WALLETS to your MetaMask PUBLIC address.
npm run dev
```

Open http://localhost:3000. Install the MetaMask browser extension and use a test wallet. Configure a comma-separated list of approved public addresses in `ANCHOR_ALLOWED_WALLETS`. Restart the server after editing environment variables. The app never needs a recovery phrase or private key. The previous `ANCHOR_PRIVATE_KEY` server signing flow has been removed.

1. Click **Connect MetaMask** and approve the connection.
2. Click **Switch to Amoy**, if prompted. The app uses Polygon Amoy, chain ID 80002 (`0x13882`), with POL as its gas token. Fund the wallet with testnet POL.
3. Wait about 30 seconds for a simulated batch, then click **Sign latest batch**. Review the zero-value transaction to the unowned anchor address `0x…dEaD` and gas fee in MetaMask. Signing is explicit; the simulator never requests signatures automatically.
4. After mining, use **Retry registration** if the initial registration happened too early. This verifies the existing transaction and does not send another one.
5. Inspect the ledger and export JSON evidence. Import an export later to reverify it or restore it to the retained ledger. Do not edit exported rows if you want them to verify.

A DANGER transition prepares an alert batch for signing; later batches can replace the unsigned preview. This preview is not a durable queue of every sensor event. Pending signed evidence is saved in this browser until registration succeeds. Export it before clearing browser storage. If a transaction is dropped/replaced or rejected by policy, export and clear the pending proof before signing again.

## What is anchored

The original repository used zero-value self-transfers with hashes in calldata. MetaMask now rejects website transactions that send data to the wall.s own account, so anchors go to the fixed unowned address `0x000000000000000000000000000000000000dEaD` instead; no smart contract deployment is required. MetaMask signs a v2 JSON payload containing the source (`sim`), device identifier, batch, count, severity, timestamp and SHA-256 of canonical reading rows. Only the digest and metadata are public on-chain; exported rows and server evidence are off-chain.

The server accepts an anchor only after checking its successful receipt, current canonical block, zero value, the fixed anchor recipient, approved transaction signer and exact payload/digest against the submitted rows. The browser address alone is never treated as authentication. Registration is idempotent for retained transaction hashes. Old v1 anchors are not silently reported as verified v2 evidence.

## Security alerts

The security panel records:

- **MISMATCH** — submitted or saved rows/metadata differ from signed evidence.
- **UNAUTHORIZED** — a transaction submitted to this app is signed by an address outside the configured allowlist. This identifies the transaction signer, not the identity of the HTTP caller.
- **REVERTED** — a submitted or monitored transaction failed.
- **REORG / MISSING RECEIPT** — a previously observed block changed or a confirmed transaction cannot be found. Reorganizations and RPC inconsistencies can cause this; it is not proof of an attack.
- **RPC UNAVAILABLE** — the application cannot verify the chain. The interface reports integrity as unknown, never verified from a stale snapshot.

Repeated identical alerts are deduplicated for five minutes. The ledger retains the latest 20 proofs; the alert log retains 30 events. Acknowledgment affects the current tab only and does not erase the server alert. **Run alert drill** creates a clearly labeled local test alert. **Enable desktop alerts** requests browser permission and shows newly observed events while the page remains open; it is not an email/SMS service.

Checks run when `/api/anchor` is requested, with a shared 10-second RPC cache; the dashboard polls every 12 seconds. To keep checks running without an open browser, run this in a second terminal while the web server stays running:

```powershell
npm run monitor
```

The monitor polls every 15 seconds and prints new alerts to its terminal. Set `MONITOR_URL` in `.env.local` to monitor a deployed instance. No persistent service or scheduled task is installed automatically. For unattended hosting, run this command under your process supervisor or have an external scheduler request `/api/anchor`.

## Persistent storage / deployment

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or the original `KV_REST_API_URL` / `KV_REST_API_TOKEN`). Without Redis, evidence and alerts use temporary process memory and can disappear on restart or differ across server instances. Configure Redis for deployment and retain independent exports. Keep credentials out of Git; `.env.local` is ignored.

```powershell
npm test
npm run build
npm start
```

The public registration endpoint has a 64 KB streamed-body bound, strict row validation, origin checks and a shared 30-request/minute admission limit. Configure network-level rate limiting for a public deployment; this admission cap is not a DDoS defense.

## Scope and limitations

These alerts detect inconsistencies in submitted/retained evidence. They cannot detect every attempt to compromise a blockchain, observe arbitrary external wallet transactions, recover deleted database history, prevent a malicious approved signer from anchoring fabricated measurements, or prove sensor truth. The web simulator and its original remote controls are not authenticated hardware ingestion. The original remote remains `/remote-8cf2c0d357`; its embedded key is public source code and is not an access-control boundary.

The allowlist is enforced by this app's registration server, not by an on-chain contract. Anybody can make their own blockchain transfers; only approved matching proofs enter this app's ledger. RPC data is trusted; a compromised RPC/server/browser, erased ledger, stolen approved wallet, or altered application code requires independent monitoring and operational controls. Keep exports and explorer links outside this app. Confirmations are shown, not claimed as irreversible finality.

## Implementation and validation

- `lib/protocol.mjs`: canonical readings, payload encoding and pure evidence checks.
- `lib/chain.js`: read-only Amoy client, registration and repeated receipt verification.
- `lib/security-store.js`: bounded evidence/alerts, deduplication, atomic Redis registration and admission cap.
- `app/BlockchainPanel.js`: MetaMask discovery (EIP-6963 with injected fallback), account/network changes, signing, recovery, ledger and alerts.
- `tests/`: adversarial protocol tests and API tests against a local mock JSON-RPC server. These never spend funds or contact a real blockchain.

MetaMask integration follows the [official provider API](https://docs.metamask.io/metamask-connect/evm/reference/provider-api/). Wallet actions and testnet transactions require manual confirmation in a real MetaMask extension. Automated fixtures do not certify a live wallet, Redis deployment, physical device or blockchain network.

## Presentation: interference detection and restriction

Open `/interference/console` in a separate tab in the same browser as the main dashboard. Keep the attempted value at 999 ppm and click **Simulate interference** there. The main dashboard contains an **Interference monitor** with no attack controls; it polls the shared sandbox session once per second. The server captures an original 505 ppm sample, recomputes the modified sample's SHA-256, rejects the mismatch with HTTP 403 and locks that sandbox writer session. The screen shows both hashes, the preserved original and an event timeline. Click **Try another write** to show a server rejection with HTTP 423. Use **Reset session** on the interference console before repeating. The monitor clears automatically. Keep both tabs on the same hostname (for example, `127.0.0.1:3002`); localhost and 127.0.0.1 are different browser origins.

This isolated sandbox works without MetaMask, POL or RPC access. It uses the same canonical hashing function as the ledger, but the baseline is held in an expiring server sandbox, not anchored on-chain. It does not change production evidence or the approved-wallet list. Sessions expire after 15 minutes and may disappear on server restart or differ across serverless instances; run locally for presentations. The restriction belongs to this sandbox session, not a real person, wallet or blockchain node.

Presentation wording: "I am simulating an attempt to replace a recorded value. The system detects a different hash, rejects the altered sample, preserves the original, and restricts further writes from this sandbox session."

## MetaMask accounts and actual record-access screen

`/interference` is the normal record-access screen. It reads registered on-chain anchors, lets a viewer propose a changed gas value, and submits the edited evidence to the actual `/api/anchor` verifier. It displays the returned HTTP status and message. It does not manufacture a breach or claim that a self-transfer's immutable calldata can be edited. The sandbox console remains separately available at `/interference/console`.

Generate fresh disposable wallets locally with `node scripts/create-test-wallets.mjs` after copying `.env.example` to `.env.local`. Their addresses and import private keys are written to `.env.test-wallets`, which is ignored by Git and is not distributed with the repository. The script fills an empty `ANCHOR_ALLOWED_WALLETS` with the approved account; an existing allowlist is preserved. Import each account into the MetaMask browser extension using its private key. Use Polygon Amoy (chain ID 80002), obtain testnet POL for the approved wallet, and sign/register one batch on the dashboard. Do not use these presentation accounts for real assets. No existing user wallet or recovery phrase is needed.

The approved wallet can anchor a batch. The second wallet is a viewer and is not approved to sign accepted anchors. A proposed change to registered rows is checked against the existing signed transaction; a mismatch returns HTTP 403 and records a server alert. This rejection preserves the original proof; it does not imply that the viewer is banned from the underlying blockchain.
