import path from "path";
import { execSync } from "child_process";
import { defineConfig, Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import commonjs from '@rollup/plugin-commonjs';

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
        // Stable, named vendor chunks. These libraries change rarely
        // relative to our app code, so pinning them into their own
        // chunks means a normal app-code deploy doesn't bust the
        // browser cache for ~600KB of unchanged vendor JS. Without
        // manualChunks, Rollup may shuffle library bytes between
        // anonymous index-* chunks on every build, invalidating the
        // cached copy even when nothing in those libs actually changed.
        //
        // Each function-style entry is matched against the resolved
        // module path. Order matters: more specific matches first.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          // Ethers/wagmi/viem stack — biggest single vendor block. Splitting
          // it from rainbowkit (UI) lets the connection-time chunk load
          // independently from the auth-time UI chunk.
          if (id.includes('/wagmi/') || id.includes('/viem/') || id.includes('/@wagmi/')) {
            return 'vendor-wagmi'
          }
          if (id.includes('/@rainbow-me/')) {
            return 'vendor-rainbowkit'
          }
          if (id.includes('/@tanstack/')) {
            return 'vendor-tanstack'
          }
          // React + scheduler + react-dom — pin together because they
          // version in lockstep and a mismatched copy crashes the app.
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react'
          }
          if (id.includes('/zod/')) {
            return 'vendor-zod'
          }
          // Everything else in node_modules falls through to Rollup's
          // automatic chunking, which keeps related deps together.
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
    coepHeadersPlugin(),
    tailwindcss(),
    react(),
    svgr(),
    tsconfigPaths(),
  ],
  resolve: {
    alias: [
      { find: "~", replacement: path.resolve(__dirname, "src") }
    ],
    conditions: ['import', 'module', 'browser', 'default'],
  },
});
