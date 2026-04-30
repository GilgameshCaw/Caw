import path from "path";
import { defineConfig, Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import commonjs from '@rollup/plugin-commonjs';

import tsconfigPaths from "vite-tsconfig-paths";

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
    }
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
