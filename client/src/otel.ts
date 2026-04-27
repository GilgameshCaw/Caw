// OpenTelemetry SDK init.
//
// MUST be imported before any module we want to instrument (express, prisma,
// ioredis, http, etc.) — auto-instrumentation works by patching require/import
// at load time. programs/start.ts imports this first for that reason.
//
// Gated on OTEL_EXPORTER_OTLP_ENDPOINT — no-op when unset, so installs that
// don't run a SigNoz collector pay zero overhead. Mirrors the Sentry DSN
// gating pattern (src/sentry.ts).
//
// Default backend is SigNoz (self-hosted). The env var is the standard OTel
// endpoint variable, so this works against any OTLP-compatible collector
// (SigNoz, Grafana Tempo, Honeycomb, etc.) without code changes.

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

let otelEnabled = false

if (endpoint) {
  // Lazy require so the SDK isn't loaded at all when disabled. Keeps startup
  // fast and the dependency footprint optional for installs that skip OTel.
  const { NodeSDK } = require('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
  const { resourceFromAttributes } = require('@opentelemetry/resources')
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions')

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'caw-backend',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'dev',
      'deployment.environment': process.env.NODE_ENV || 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      // OTLP/HTTP — SigNoz collector listens on :4318/v1/traces by default.
      // The env var is the COLLECTOR base; the exporter appends /v1/traces.
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs auto-instrumentation generates a span per readFile/stat — way
        // too noisy for our use (logs, prisma binaries, every config read).
        // Disable it; we don't have a "slow disk I/O" question to answer.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // dns auto-instrumentation is similar — high-cardinality, low-signal.
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  })

  sdk.start()
  otelEnabled = true

  // Flush traces on shutdown so the last batch isn't lost. SIGTERM handler
  // here doesn't conflict with runServices' SIGINT handler (different signals).
  process.on('SIGTERM', () => {
    sdk.shutdown().catch((err: unknown) => console.error('[otel] shutdown error', err))
  })
}

export { otelEnabled }
