# AirSafe — Air Safety Monitor

ESP32 firmware and a Next.js dashboard with MetaMask-signed Polygon Amoy evidence, an editable record-verification interface, and security alerts.

The web application currently generates its sensor readings in the browser. It does **not** ingest the ESP32 firmware's readings. Blockchain transactions are real Amoy testnet transactions when signed and funded; the sensor values remain generated. No smart contract deployment is required.

## Interfaces

| Route | Purpose |
| --- | --- |
| `/` | Air readings, chart, MetaMask connection, batch signing, evidence ledger and security alerts |
| `/interference` | Normal record-access interface: view an anchored batch, propose a changed gas value and inspect the server's verification response |
| `/interference/demo` | Separate controlled interference console with an isolated sandbox session |
| `/#interference-demo` | Dashboard monitor for the sandbox console; updates automatically across same-browser tabs |
| `/remote-8cf2c0d357` | Original remote for changing the generated sensor feed; its public embedded key is not secure authentication |

## Requirements

- Node.js 22.9 or later (validated with Node 24), npm and Git.
- MetaMask browser extension for signing; use a browser that supports the extension.
- Amoy testnet POL for transaction fees. Reading the dashboard needs no wallet.
- Optional Upstash Redis for shared, persistent evidence and alerts.

## Quick start

```powershell
git clone --branch ninja https://github.com/SHARVESH08/air-safety-monitor.git
cd air-safety-monitor/web
npm ci
Copy-Item .env.example .env.local
```

Edit `.env.local` and set `ANCHOR_ALLOWED_WALLETS` to one or more comma-separated public wallet addresses. Then run:

```powershell
npm run dev
```

Open `http://localhost:3000`. Restart the server after environment changes. Use the same hostname and port for both dashboard and interference tabs. `localhost` and `127.0.0.1` have separate browser storage.

For the port used in the local project preview:

```powershell
npm run dev -- --hostname 127.0.0.1 --port 3002
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ANCHOR_ALLOWED_WALLETS` | Approved signer public addresses; registration is disabled when empty |
| `AMOY_RPC_URL` | Trusted Polygon Amoy RPC URL; example provided in `.env.example` |
| `UPSTASH_REDIS_REST_URL` | Optional Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Optional Redis REST token; configure both Redis variables together |
| `MONITOR_URL` | Optional background monitor target; default `http://127.0.0.1:3000` |

The original `KV_REST_API_URL` / `KV_REST_API_TOKEN` variable names are also accepted. Server-side `ANCHOR_PRIVATE_KEY` signing has been removed. The web application does not need a wallet private key or recovery phrase.

### Optional disposable MetaMask accounts

Use existing test wallets or generate two fresh wallets locally:

```powershell
# Run inside web/, after npm ci and copying .env.example.
node scripts/create-test-wallets.mjs
```

The script writes `.env.test-wallets` with public addresses and import private keys for an approved signer and an unapproved viewer. It fills an empty `ANCHOR_ALLOWED_WALLETS` with the approved address, preserves an existing allowlist, and refuses to overwrite an existing wallet file. Import each private key into MetaMask as a separate account. Use these wallets only for testnet assets. Keys and `.env.local` are ignored by Git and are **not included in this repository**. Each clone generates its own accounts.

## MetaMask and a real anchored-record check

1. On the dashboard, connect the approved MetaMask account.
2. Switch to **Polygon Amoy**, chain ID **80002** (`0x13882`), gas currency **POL**. Obtain testnet POL before signing.
3. Wait about 30 seconds, then select **Sign latest batch**. Approve the zero-value self-transfer and its network fee in MetaMask.
4. Once mined, select **Retry registration** if necessary. This reuses the transaction; it does not ask for another signature or pay another transaction fee.
5. Open `/interference`, refresh records and select the registered transaction. Select a reading, change its gas value and choose **Submit edited record**.
6. The server recomputes the submitted evidence and compares it with the signed transaction. Altered evidence is rejected with **HTTP 403** and a security alert; the original registered proof remains intact.
7. Use the second MetaMask account to show viewer access. Its address is not approved to sign accepted new anchors.

This verifies an edited off-chain copy against immutable on-chain evidence. The interface cannot rewrite a confirmed blockchain transaction. It displays actual server responses and does not claim that a rejected HTTP request bans a person from the blockchain.

Only hashes and metadata are anchored. Keep exported JSON evidence to preserve the original readings independently. The ledger retains the latest 20 registered proofs. Unsigned batch previews are replaced by later batches rather than queued indefinitely.

## Separate interference demonstration

For a presentation without wallet funding or an existing transaction:

1. Open the dashboard and `/interference/demo` in separate tabs in the same browser and on the same origin.
2. On the separate console, select **Start demo session**.
3. Keep the proposed value at **999 ppm** and select **Simulate interference**.
4. The server compares its protected **505 ppm** baseline with the modified sample, returns **HTTP 403**, and restricts that sandbox session. The dashboard automatically shows both hashes, the preserved original and the event timeline.
5. Select **Try another write** to demonstrate **HTTP 423** for the restricted session.
6. Select **Reset demonstration** to clear the session in both tabs.

The sandbox uses the same canonical SHA-256 hashing function as the ledger, but its baseline is local server memory and is not anchored on-chain. It changes no real wallet permissions. Sessions expire after 15 minutes and may disappear on server restart; use one local server instance for this presentation.

## Alerts and monitoring

The security panel detects mismatched readings/metadata, submitted transactions from unapproved signers, reverted transactions, changed or missing receipts, and RPC verification outages. It does not label stale evidence as verified when the RPC is unavailable. Reorganization or RPC inconsistency is a warning signal, not proof of an attacker.

Identical alerts are deduplicated for five minutes, with 30 recent events retained. Desktop notifications require browser permission and an open page. Acknowledgment is local to the current tab. **Run alert drill** creates a labeled local alert.

The dashboard polls every 12 seconds; the server shares a 10-second verification cache. To keep verification running without an open page, leave the web server running and start a second terminal:

```powershell
cd air-safety-monitor/web
npm run monitor
```

Set `MONITOR_URL` to the correct origin when using port 3002 or a deployed instance. The monitor polls every 15 seconds and prints new alerts. It does not install a scheduled task or send email/SMS. For unattended operation, run it under a process supervisor or have an external scheduler call `GET /api/anchor`.

## Persistence, validation and production build

Configure both Redis variables for persistence across restarts and multiple server processes. Without Redis, evidence and alerts use temporary process memory. The interference sandbox always uses local memory, including when Redis is configured.

```powershell
cd air-safety-monitor/web
npm test
npm run build
npm start
```

For a production preview on port 3002:

```powershell
npm run start -- --hostname 127.0.0.1 --port 3002
```

Stop an existing production server before rebuilding on Windows to avoid locked `.next` files.

The suite contains 34 protocol, API and sandbox tests. API tests use a local mock JSON-RPC server and spend no funds. See [web/VALIDATION.md](web/VALIDATION.md) for the checks performed and their limits. Automated wallet fixtures do not establish that a real funded wallet, Redis deployment or physical device works.

## Troubleshooting

- **Not approved / no signing:** set the correct public address in `ANCHOR_ALLOWED_WALLETS`, restart the server and select that account in MetaMask.
- **No anchored records:** sign and register one confirmed batch first; the record-access page does not invent sample transactions.
- **Not confirmed yet:** wait for mining and retry registration, rather than signing again.
- **RPC unavailable:** verify Amoy endpoint access. Integrity is unknown until verification recovers.
- **Pending transaction dropped or replaced:** export the pending evidence, then use the export-and-clear control before signing again.
- **No MetaMask provider:** use a browser with the MetaMask extension; an in-app browser may not expose it.
- **Demo tab not updating:** use the same browser, hostname and port; start a fresh session after a restart or its 15-minute expiry.

## Project layout and boundaries

- `firmware/AirSafetyMonitor/`: ESP32 Arduino sketch for MQ135, BMP280, DS3231, LDR, HC-SR04/servo, OLED, LED, buzzer and relay. Configure Wi-Fi and destination URL before flashing; the web server currently has no hardware ingestion endpoint.
- `web/app/`: dashboard, wallet/evidence UI, normal record editor, sandbox console and API routes.
- `web/lib/`: generated readings, canonical hashing, RPC verification, evidence/alerts, origin validation and isolated sandbox sessions.
- `web/scripts/`: optional continuous monitor and local disposable-wallet generator.
- `web/tests/`: protocol and API tests.

The allowlist is an application rule, not an on-chain access-control contract. Alerts cover submitted and retained evidence; they do not detect every blockchain attack, recover erased history, prove sensor truth or prevent an approved signer from anchoring fabricated measurements. Registration has bounded request parsing, origin checks and an admission cap; public deployments still need appropriate network-level rate limits.

Further technical details are in [web/README.md](web/README.md).
