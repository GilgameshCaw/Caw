import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// Standalone verifier app. Ships to verify.caw.social (a host you control
// directly, not delegated to any mirror operator). Kept deliberately tiny
// — no wagmi/rainbowkit/i18n; the verifier's whole value proposition is
// that its code is small enough to audit by reading.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5275,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
