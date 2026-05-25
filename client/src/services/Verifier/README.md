# CAW Verifier

Standalone tool for verifying that a CAW mirror is serving the same frontend
bundle as the canonical upstream repo. Ships to `verify.caw.social` — a host
deliberately separate from any mirror so it can't be tampered with by the
mirror being audited.

## How it works

1. The user enters a mirror URL (e.g. `https://test.caw.social`).
2. The verifier fetches the canonical reference manifest from
   `raw.githubusercontent.com/<canonical-repo>/master/docs/manifests/latest.json`.
   The reference URL is **hardcoded** in `src/App.tsx` so the mirror can't redirect it.
3. For every file listed in the reference manifest, the verifier fetches
   that file from the mirror and computes its SHA-256 client-side via
   `crypto.subtle.digest`. Direct fetch, no proxy.
4. The hashes are compared. Match → green; mismatch / missing / errored → red,
   with a per-file diff table.

## What it does NOT do

- Send any credentials. `fetch(..., { credentials: 'omit' })` throughout.
- Vouch for the backend that the mirror's FE talks to.
- Vouch for the on-chain contracts the FE points at. (Both planned as
  separate pillars — see `docs/VERIFIER_PILLARS.md`.)
- Trust anything the mirror under audit says about itself, with one
  exception: the mirror's own `build-manifest.json` is read for its
  `clientVersion` field as a diagnostic hint ("the mirror is on commit X,
  the reference is on commit Y, that's why the hashes differ"). It is
  never trusted for file hashes.

## Build

```sh
cd client/src/services/Verifier
npm install
npm run build
```

Output lands in `dist/`. Static, no server runtime needed.

## Deploy

`verify.caw.social` is served by nginx as static files. Example config in
`docs/VERIFIER_DEPLOY.md`. Requires:

- A host **you control directly**, not delegated to a Network operator.
  If a mirror operator can swap the verifier's bytes, the trust loop reopens.
- `Access-Control-Allow-Origin: https://verify.caw.social` (or `*`) on each
  mirror's `/assets/*` and `/build-manifest.json` paths so the in-browser
  fetch + hash can read them.

## Audit checklist

The verifier's correctness depends on a small surface:

- `src/verify.ts` — all the verification logic, no UI. ~150 lines.
- `src/App.tsx` — UI shell. Only inputs: the mirror URL the user typed,
  and the hardcoded `MANIFEST_URL` constant.
- `vite.config.ts` — no plugins beyond React.

If you find any other code path that influences the pass/fail outcome,
that's a bug. Open an issue.
