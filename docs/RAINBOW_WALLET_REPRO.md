# Rainbow Wallet Connection Failure — Reproduction Guide

## Context

Rainbow Mobile fails to connect to `test.caw.social` via WalletConnect v2. Most
likely root cause: `VITE_PROJECT_ID` (Reown / WalletConnect Cloud project id)
is either unset on the prod VPS or the project's origin allowlist on
cloud.reown.com does not include `https://test.caw.social`. Either condition
makes Rainbow scan the QR but never receive a session proposal back from the
relay, presenting as a silent timeout in the wallet.

## Env vars to verify

- `VITE_PROJECT_ID` — Reown / WalletConnect Cloud project id, baked into the
  FE bundle at build time. Inspect via `pm2 env <fe-pid>` then trigger a
  rebuild, or grep the built bundle in `client/src/services/FrontEnd/dist/`.
- The project's allowlist on https://cloud.reown.com → Project → Domains
  must include `https://test.caw.social` (no path, no trailing slash).

## Steps to reproduce

1. Open `https://test.caw.social` in desktop Chrome (or any dektop browser).
2. Open DevTools → Console. Confirm the new diagnostic line:
   `[Web3Provider] projectId=<id> origin=https://test.caw.social`.
3. Click "Connect Wallet" → choose Rainbow → desktop shows the WalletConnect QR.
4. Open Rainbow Mobile, tap the scan icon, scan the QR.
5. Observe: Rainbow shows a brief loading spinner then returns to the wallet
   home screen with no connection prompt. Desktop QR stays open indefinitely.

## What to capture

- Full console output from page load through the failed scan, including the
  `[Web3Provider] projectId=… origin=…` line and any warning about
  `VITE_PROJECT_ID is unset`.
- DevTools → Network tab, filtered to `walletconnect`: capture every
  request to `relay.walletconnect.com` / `relay.walletconnect.org` and the
  status code (403 = origin not allowlisted, 401 = bad projectId).
- The exact `projectId` value printed in console — compare against the id
  shown on cloud.reown.com.
- Rainbow Mobile build version (Settings → About).
