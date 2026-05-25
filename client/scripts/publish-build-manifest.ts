// Copy the freshly-built FE manifest into docs/manifests/ so the standalone
// verifier at verify.caw.social can fetch it as the canonical reference.
//
// Run after every FE build that's about to ship:
//   npx tsx client/scripts/publish-build-manifest.ts
//
// Writes two files:
//   docs/manifests/<clientVersion>.json — the immutable per-build snapshot
//   docs/manifests/latest.json          — moving pointer to the current build
//
// The verifier hits latest.json. Old builds remain on disk indefinitely so
// you can verify any historical mirror state by reading from the per-version
// path directly.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FE_DIST = path.join(REPO_ROOT, 'client', 'src', 'services', 'FrontEnd', 'dist');
const MANIFEST_SRC = path.join(FE_DIST, 'build-manifest.json');
const MANIFESTS_DIR = path.join(REPO_ROOT, 'docs', 'manifests');

async function main() {
  if (!existsSync(MANIFEST_SRC)) {
    throw new Error(
      `No build manifest at ${MANIFEST_SRC}. Run \`npm run build\` in client/src/services/FrontEnd/ first.`
    );
  }
  const raw = await readFile(MANIFEST_SRC, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1) {
    throw new Error(`Unexpected manifest schema version ${parsed.version}`);
  }
  if (typeof parsed.clientVersion !== 'string' || !parsed.clientVersion) {
    throw new Error('Manifest missing clientVersion');
  }

  await mkdir(MANIFESTS_DIR, { recursive: true });
  const versionedPath = path.join(MANIFESTS_DIR, `${parsed.clientVersion}.json`);
  const latestPath = path.join(MANIFESTS_DIR, 'latest.json');

  await writeFile(versionedPath, raw, 'utf8');
  await writeFile(latestPath, raw, 'utf8');

  // eslint-disable-next-line no-console
  console.log(`Published manifest for ${parsed.clientVersion}`);
  console.log(`  → ${path.relative(REPO_ROOT, versionedPath)}`);
  console.log(`  → ${path.relative(REPO_ROOT, latestPath)}`);
  console.log(`  ${Object.keys(parsed.files).length} files tracked`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
