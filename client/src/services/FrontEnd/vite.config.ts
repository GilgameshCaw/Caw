/// <reference types="vitest" />
import path from "path";
import { execSync } from "child_process";
import { defineConfig, Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import commonjs from '@rollup/plugin-commonjs';
import { VitePWA } from 'vite-plugin-pwa';

import tsconfigPaths from "vite-tsconfig-paths";

// Stamp every build with the current git SHA so we can correlate frontend
// builds with their server-side TxQueue rows (the API persists this from the
// X-Caw-Client-Version header). Keeps stale-FE bugs diagnosable: when a row
// fails, you can see whether it came from a build that pre-dated the fix.
function buildClientVersion(): string {
  if (process.env.CAW_CLIENT_VERSION) return process.env.CAW_CLIENT_VERSION;
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    let dirty = '';
    try {
      const status = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      if (status) dirty = '+dirty';
    } catch {}
    return `${sha}${dirty}`;
  } catch {
    return 'unknown';
  }
}
const CLIENT_VERSION = buildClientVersion();
// Expose to index.html templating (%VITE_CLIENT_VERSION%) so the
// bfcacheGuard freshness probe can read the deployed version from a
// <meta name="caw-client-version"> tag without extra JS entrypoints.
process.env.VITE_CLIENT_VERSION = CLIENT_VERSION;

// Emit dist/build-manifest.json after build: every file shipped to clients,
// keyed by its served path, paired with its SHA-256. The standalone verifier
// at verify.caw.social uses this to detect tampered mirrors — it fetches the
// mirror's manifest, hashes the served files itself, and cross-checks against
// the canonical manifest published in the upstream repo. Mirrors can't lie
// about file content without also lying about the manifest, and the verifier
// reads the canonical manifest from a host you control, not from the mirror.
function buildManifestPlugin(clientVersion: string): Plugin {
  return {
    name: 'caw-build-manifest',
    apply: 'build',
    async closeBundle() {
      const fs = await import('fs/promises');
      const crypto = await import('crypto');
      const distDir = path.resolve(__dirname, 'dist');
      // Files we never want in the manifest:
      // - service-worker artifacts (sw.js / workbox-*.js): content depends on
      //   workbox internals and the manifest of OTHER files, which is itself
      //   what we're emitting — chicken/egg. The PWA install integrity is a
      //   separate concern from "is this the upstream bundle".
      // - the manifest itself.
      const skip = new Set(['build-manifest.json', 'sw.js']);
      const skipPrefix = ['workbox-'];
      async function walk(dir: string, prefix: string): Promise<Array<[string, string]>> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const out: Array<[string, string]> = [];
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            out.push(...await walk(full, rel));
          } else if (e.isFile()) {
            if (skip.has(rel)) continue;
            if (skipPrefix.some(p => e.name.startsWith(p))) continue;
            const buf = await fs.readFile(full);
            const sha = crypto.createHash('sha256').update(buf).digest('hex');
            out.push([rel, `sha256-${sha}`]);
          }
        }
        return out;
      }
      const entries = await walk(distDir, '');
      // Stable sort so the manifest is deterministic for byte-level diffs
      // across re-runs of the same commit.
      entries.sort(([a], [b]) => a.localeCompare(b));
      const manifest = {
        version: 1,
        clientVersion,
        builtAt: new Date().toISOString(),
        files: Object.fromEntries(entries),
      };
      await fs.writeFile(
        path.join(distDir, 'build-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      const distinct = entries.length;
      // eslint-disable-next-line no-console
      console.log(`[build-manifest] wrote dist/build-manifest.json (${distinct} files, version ${clientVersion})`);
    }
  };
}

// Plugin to add COEP headers to worker responses (only on localhost for security)
function coepHeadersPlugin(): Plugin {
  return {
    name: 'configure-server',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Only apply COOP/COEP headers on localhost (browsers ignore them on non-HTTPS non-localhost)
        const host = req.headers.host || '';
        const isLocalhost = host.startsWith('localhost:') || host === 'localhost';

        if (isLocalhost) {
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        }
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "/",
  define: {
    global: 'globalThis',
    __CLIENT_VERSION__: JSON.stringify(CLIENT_VERSION),
  },
  // argon2-browser bundles a .wasm file via require() inside its lib/argon2.js.
  // Vite/Rollup tries to interpret that as an ESM-Wasm module and fails because
  // the "ESM integration proposal for Wasm" is not yet supported in Rollup.
  // We exclude it from optimizeDeps so Vite doesn't pre-bundle it, and treat
  // the .wasm as a static asset (URL) at build time. argon2-browser loads the
  // WASM at runtime via fetch() so it resolves correctly.
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext'
    },
    exclude: ['argon2-browser']
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true
    },
    rollupOptions: {
      output: {
        // Pull only @rainbow-me into its own named chunk. It's the
        // single biggest vendor block (~1.8MB) and its dep graph
        // (rainbowkit → wagmi/viem → react) is internally consistent,
        // so Rollup correctly emits modulepreloads in the right order.
        //
        // Tried splitting react / wagmi / tanstack into their own
        // chunks too — the cache-stability win was real, but Rollup
        // doesn't always emit dep-order edges across manual chunk
        // boundaries. tanstack would preload before react, then crash
        // with "Cannot read properties of undefined (reading
        // 'createContext')" because React.createContext was undefined
        // at module-init time. Letting Rollup auto-chunk the rest
        // keeps the order correct at the cost of a slightly less
        // cache-friendly entry chunk.
        manualChunks(id) {
          if (id.includes('/@rainbow-me/')) return 'vendor-rainbowkit'
          return undefined
        },
      },
    },
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 5274,
    strictPort: true, // Fail loudly if 5274 is taken rather than silently climbing to the next port
    host: true, // Bind to 0.0.0.0 so other devices on the LAN (e.g. a phone) can hit the dev server
    allowedHosts: true, // Allow all hosts in development
    // Note: COOP/COEP headers are set conditionally in coepHeadersPlugin()
    // They only work on localhost or HTTPS origins (browsers ignore them otherwise)
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Uploaded media files (avatars, post images, videos). The API
      // returns absolute URLs built from publicUrl(), which in dev points
      // at the Vite host (5274) — proxy to the API so those URLs resolve.
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Only proxy /s/ paths (short URLs), not /src/
      '^/s/': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path // Keep path as-is
      }
    }
  },
  // vite-plugin-image-optimizer was removed — it depends on `sharp`,
  // whose linux-x64 prebuilt requires the v2 microarchitecture and
  // breaks on QEMU virtual CPUs (the same VPS class our installs run
  // on). On those hosts the plugin failed to load and emitted a
  // multi-line warning per static asset on every build, drowning out
  // real deploy output. Static assets in public/ are already
  // hand-optimized; user-uploaded images go through the browser-side
  // compressImage.ts pipeline, not this plugin. Net loss: ~zero.
  plugins: [
    buildManifestPlugin(CLIENT_VERSION),
    coepHeadersPlugin(),
    tailwindcss(),
    react(),
    svgr(),
    tsconfigPaths(),
    // PWA: makes the app installable ("Add to Home Screen" on Chrome
    // Android + desktop, plus richer iOS Safari install support).
    //
    // Chrome's install prompt requires (a) a valid web manifest and (b)
    // a registered service worker with a fetch handler. The manifest at
    // public/site.webmanifest stays authoritative — `manifest: false`
    // tells vite-plugin-pwa not to emit its own competing one or
    // re-link it from index.html.
    //
    // registerType: 'autoUpdate' + skipWaiting = the new SW activates
    // immediately on deploy instead of stalling on a "waiting" state,
    // avoiding the classic PWA problem where every deploy strands users
    // on the previous bundle until they manually close every tab.
    //
    // clientsClaim is intentionally OFF (#319): with it on, the SW that
    // installs on the FIRST visit claims the still-loading page mid-flight
    // — in-flight asset requests get rerouted through a half-warmed cache
    // and Safari/iOS in particular falls back to the index.html shell for
    // JS chunks, leaving the user staring at a blank or partial render
    // until they reload. Without clientsClaim the first visit completes
    // over plain network (clean render), and the SW takes control on the
    // next navigation/reload — same end state, no first-load race.
    //
    // navigateFallback: SPA shell fallback for offline navigation.
    // navigateFallbackDenylist excludes API + uploads + the OG/short-URL
    // routes so requests for those don't get the index.html shell back.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false,
      includeAssets: [
        'favicon.ico',
        'favicon/*.png',
        'apple-touch-icon.png',
        'site.webmanifest',
      ],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/uploads\//,
          /^\/s\//,
        ],
        cleanupOutdatedCaches: true,
        // clientsClaim intentionally omitted — see the block comment above
        // the VitePWA call. Keeping skipWaiting alone is enough for the
        // fast-deploy behaviour without the first-install race.
        skipWaiting: true,
        // Bump for large vendor chunks (rainbowkit ~1.8MB) so they get
        // precached instead of skipped with a "size exceeded" warning.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        // Don't register the SW in dev — Vite HMR + workbox precache
        // fight each other and serve stale assets across reloads.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: [
      { find: "~", replacement: path.resolve(__dirname, "src") }
    ],
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // passkey.test.ts uses node:test, not vitest — exclude it from this runner
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/src/services/identity/passkey.test.ts',
    ],
  },
});
