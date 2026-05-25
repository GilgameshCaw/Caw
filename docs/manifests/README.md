# Build manifests

Reference SHA-256 manifests for the CAW frontend bundle. Used by the
standalone verifier at `verify.caw.social` to detect tampered mirrors.

Each `<clientVersion>.json` is an immutable snapshot of one FE build:
which files it shipped and their hashes. `latest.json` is a moving pointer
to the most recent published build.

Generate by running, from repo root, after a fresh FE build:

```sh
npx tsx client/scripts/publish-build-manifest.ts
```

Then commit the new files. The verifier fetches:

```
https://raw.githubusercontent.com/<repo>/master/docs/manifests/latest.json
```

so updates flow as soon as the commit lands on master. The per-version
files remain on disk indefinitely — a user can verify a historical mirror
state by pointing the verifier at the matching `<clientVersion>.json`.
