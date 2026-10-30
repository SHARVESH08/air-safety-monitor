# Validation — 30 October 2026

- `npm run build`: passed, Next.js production build.
- `npm test`: 34 tests passed (15 protocol tests, 10 anchor API integration tests and 9 sandbox tests).
- API tests use a local mock JSON-RPC server: verified registration, duplicate handling, changed evidence, unapproved signer, saved-data modification, canonical block change, missing receipt, RPC outage/recovery, request bounds/origin and missing allowlist.
- Playwright browser checks passed using a mock injected wallet and mocked anchor API: approved-wallet connection, Amoy switching, rejected signature, explicit signing and 30-row evidence registration, alert drill/acknowledgment and account revocation.
- Desktop (1440 px) and mobile (390 px) screenshots inspected; no document overflow or JavaScript runtime errors in the wallet acceptance run.
- The unmocked dashboard was loaded locally and the public Amoy RPC returned a chain height. No real wallet transaction was submitted.

Not exercised: a real MetaMask extension signing a funded transaction, real Redis persistence/Lua execution, serverless deployment, unattended process supervision, desktop notification delivery, or physical ESP32 ingestion. The dashboard source remains simulated.

Local browser artifacts are in `output/playwright/` (ignored by Git). These are local validation results; no smart contract or public website was deployed during these checks.

Separate interference console acceptance: passed against the real local sandbox endpoint (no mocked API). A write from the sandbox console (now `/interference/console`) propagated automatically to a second dashboard tab, which showed hash mismatch, preserved 505 ppm, restricted session and subsequent write denial. Reset propagated to both tabs. No JavaScript runtime errors; no mobile console document overflow. Expected HTTP 403 and 423 responses appear in the browser network log.

Record-access interface: production build passed; the actual `/interference` page was checked in Chromium with no registered anchors and an unconnected wallet. The screen correctly showed public-viewer access and the empty-record setup state. No fabricated transaction/rejection screenshot was used. New disposable test-wallet keys were saved only in ignored `.env.test-wallets`; only the approved public address was added to the allowlist. Real MetaMask import, faucet funding, signing and end-to-end record rejection still require the user's test-wallet setup.
