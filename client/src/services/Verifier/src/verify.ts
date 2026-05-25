// Pure verification primitives. No React, no DOM, no side effects beyond
// fetch + SubtleCrypto. If you're auditing this tool, this is the file
// that decides "match" vs "mismatch" — everything in App.tsx is just
// presentation.

export type ManifestV1 = {
  version: 1;
  clientVersion: string;
  builtAt: string;
  files: Record<string, string>; // path -> "sha256-<hex>"
};

export type FileResult =
  | { path: string; status: 'match'; expectedHash: string; actualHash: string }
  | { path: string; status: 'mismatch'; expectedHash: string; actualHash: string }
  | { path: string; status: 'missing'; expectedHash: string }
  | { path: string; status: 'extra'; actualHash: string }
  | { path: string; status: 'error'; expectedHash?: string; error: string };

export type FrontendReport = {
  ok: boolean;
  mirrorUrl: string;
  mirrorClientVersion?: string;
  referenceClientVersion?: string;
  files: FileResult[];
  summary: {
    matched: number;
    mismatched: number;
    missing: number;
    extra: number;
    errored: number;
  };
};

// SHA-256 over the raw bytes a mirror serves. Matches what the build-manifest
// plugin computes server-side — both use the file's raw bytes, no encoding
// fiddling. Format: "sha256-<lowercase hex>" so a side-by-side string compare
// with the manifest entry is sufficient.
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return `sha256-${hex}`;
}

// Normalize whatever the user pastes into the host portion of a URL.
// Strips trailing slashes, accepts bare hostnames (defaults to https://).
export function normalizeMirrorUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  // Strip trailing slash so we don't double them when joining paths.
  s = s.replace(/\/+$/, '');
  // Validate.
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  return `${u.protocol}//${u.host}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    // No credentials — we're a stranger inspecting a third-party host.
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.json() as T;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.arrayBuffer();
}

function isManifest(x: unknown): x is ManifestV1 {
  if (!x || typeof x !== 'object') return false;
  const m = x as Partial<ManifestV1>;
  return m.version === 1
    && typeof m.clientVersion === 'string'
    && typeof m.builtAt === 'string'
    && !!m.files
    && typeof m.files === 'object';
}

// Compare a mirror's bundle against a reference manifest. The reference
// manifest is the source of truth — every file listed in it must be served
// by the mirror with a byte-identical SHA-256. Files the mirror serves but
// the reference doesn't know about are reported as "extra" (not a hard
// failure by itself; e.g. a mirror might serve favicons we never published).
export async function verifyFrontend(
  mirrorUrl: string,
  referenceManifest: ManifestV1,
  opts?: { onProgress?: (done: number, total: number, path: string) => void; concurrency?: number },
): Promise<FrontendReport> {
  const mirror = normalizeMirrorUrl(mirrorUrl);
  const concurrency = Math.max(1, Math.min(16, opts?.concurrency ?? 6));

  // First, fetch the mirror's *own* manifest. We don't trust it for hashes,
  // but it tells us which files the mirror claims to ship + its clientVersion,
  // which is useful diagnostic info (lets us flag "this mirror is on an older
  // commit than the reference, which explains some hash mismatches").
  let mirrorManifest: ManifestV1 | null = null;
  try {
    const raw = await fetchJson<unknown>(`${mirror}/build-manifest.json`);
    if (isManifest(raw)) mirrorManifest = raw;
  } catch {
    // Mirror without a manifest is still verifiable — we hash the files
    // it serves regardless. The clientVersion field will just be unknown.
  }

  const expectedPaths = Object.keys(referenceManifest.files);
  const mirrorPaths = new Set(mirrorManifest ? Object.keys(mirrorManifest.files) : []);

  const results: FileResult[] = [];
  let done = 0;

  // Bounded concurrency: too many parallel requests against one origin
  // gets rate-limited; serial is too slow for a 100+ file bundle.
  async function worker(queue: string[]) {
    while (queue.length) {
      const p = queue.shift()!;
      const expected = referenceManifest.files[p];
      try {
        const bytes = await fetchBytes(`${mirror}/${p}`);
        const actual = await sha256Hex(bytes);
        if (actual === expected) {
          results.push({ path: p, status: 'match', expectedHash: expected, actualHash: actual });
        } else {
          results.push({ path: p, status: 'mismatch', expectedHash: expected, actualHash: actual });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 404 → missing; everything else → error.
        if (/HTTP 404/.test(msg)) {
          results.push({ path: p, status: 'missing', expectedHash: expected });
        } else {
          results.push({ path: p, status: 'error', expectedHash: expected, error: msg });
        }
      }
      done++;
      opts?.onProgress?.(done, expectedPaths.length, p);
    }
  }

  const queue = expectedPaths.slice();
  await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));

  // Files the mirror's manifest claimed but the reference doesn't list.
  // We do NOT hash these — we don't know what they should be. Just flag
  // them for the user to eyeball.
  for (const p of mirrorPaths) {
    if (!referenceManifest.files[p]) {
      results.push({ path: p, status: 'extra', actualHash: '(not hashed)' });
    }
  }

  // Stable sort for readable output.
  results.sort((a, b) => a.path.localeCompare(b.path));

  const summary = {
    matched: results.filter(r => r.status === 'match').length,
    mismatched: results.filter(r => r.status === 'mismatch').length,
    missing: results.filter(r => r.status === 'missing').length,
    extra: results.filter(r => r.status === 'extra').length,
    errored: results.filter(r => r.status === 'error').length,
  };

  // The mirror passes iff every reference file matched. Missing/mismatched/
  // errored counts ALL count as failure — a hostile mirror could 404 the
  // file we want to hash and our verifier would otherwise call that a pass.
  const ok = summary.mismatched === 0
    && summary.missing === 0
    && summary.errored === 0
    && summary.matched === expectedPaths.length;

  return {
    ok,
    mirrorUrl: mirror,
    mirrorClientVersion: mirrorManifest?.clientVersion,
    referenceClientVersion: referenceManifest.clientVersion,
    files: results,
    summary,
  };
}

// Fetch the canonical manifest published by the upstream repo. The URL is
// hardcoded in App.tsx so a hostile party can't redirect the verifier to
// their own "reference."
export async function fetchReferenceManifest(url: string): Promise<ManifestV1> {
  const raw = await fetchJson<unknown>(url);
  if (!isManifest(raw)) throw new Error('Reference manifest schema mismatch (expected version 1)');
  return raw;
}
