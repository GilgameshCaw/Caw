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
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext'
    }
  },
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
        // Keep the browser's Host header (localhost:5274) intact. The
        // wallet-auth domain binding in api/routes/auth.ts compares the
        // signed message's Host against req.headers.host; changeOrigin:true
        // would rewrite it to localhost:4000 and 400 every login in dev.
        changeOrigin: false,
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
    // registerType: 'autoUpdate' = new SW takes control on next page
    // load instead of stalling on a "waiting" state. Combined with
    // skipWaiting + clientsClaim, this avoids the classic PWA
    // problem where every deploy strands users on the previous bundle
    // until they manually close every tab.
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
        clientsClaim: true,
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
});
