/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

// Build-time git SHA injected by vite.config.ts via `define`. Sent on every
// API request as X-Caw-Client-Version so the server can correlate failures
// with the FE build that produced them.
declare const __CLIENT_VERSION__: string;

// qrcode ships no TypeScript types. We only use a tiny subset of the API
// (dynamic import + toDataURL) so a minimal ambient declaration is enough.
declare module 'qrcode';
