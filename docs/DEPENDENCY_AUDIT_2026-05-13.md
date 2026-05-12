# Dependency audit — 2026-05-13

## Summary

| Package | Total | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| `client/` | 28 | 1 | 18 | 8 | 1 |
| `solidity/` | 81 | 7 | 21 | 33 | 20 |
| `smltxt/` | 2 | 0 | 2 | 0 | 0 |
| `cli/` | 0 | — | — | — | — |

`client/` is the runtime production surface — that's where the audit should focus. `solidity/` and `smltxt/` are dev-tooling / build-time dependencies; CVEs there matter less unless they affect compilation or deploy.

## Client (production runtime) — actionable findings

### CRITICAL

**protobufjs — Arbitrary code execution**
- Advisory: GHSA-xq3m-2v4x-88gg
- Reachable through: transitive (likely opentelemetry stack)
- Action: `npm audit fix` should bump it via the parent. Verify after fix that nothing in our prod code-path imports protobufjs directly with untrusted input.

### HIGH — actionable

**undici** — multiple CVEs (WebSocket 64-bit length overflow, request smuggling, etc.)
- One of the biggest blast radii: undici is the default fetch implementation in modern Node.
- `npm audit fix` should resolve. We use undici via `node:fetch` indirectly.

**path-to-regexp** — ReDoS via sequential optional groups
- Used by express. Real attack surface: a malicious URL pattern can hang the matcher.
- Fix via `npm audit fix`. Verify Express version compatibility.

**lodash / lodash-es** — Prototype pollution in `_.unset` / `_.omit`
- Search the codebase for `.unset(` or `.omit(` calls against user-controlled paths to bound the impact.

**socket.io-parser** — Unbounded binary attachments
- Used by our WebSocket DM relay. Verify whether we expose a path that lets an attacker send arbitrary binary attachments.

**serialize-javascript** — RCE via RegExp.flags / Date.prototype.toISOString
- Transitive. Bump via `npm audit fix`.

**flatted** — Unbounded recursion DoS in parse()
- Used by JSON-circular-ref tooling. Likely transitive logging dep.

**fast-xml-builder** — Attribute injection
- Transitive. We don't directly emit XML in product features; sitemap.ts is the only place with XML output, and it doesn't use this library.

**minimatch** / **picomatch** — ReDoS / method injection in glob matching
- Build-time, but check if any runtime route uses them on user input.

**effect** — AsyncLocalStorage context contamination under concurrent load with RPC
- This is in the otel/effect stack. Worth verifying: does our request-context propagation use this?

**@opentelemetry/auto-instrumentations-node + @opentelemetry/exporter-prometheus + @opentelemetry/sdk-node** — Prometheus exporter process crash via malformed HTTP request
- We use opentelemetry. Bump these. The crash is triggered by a malformed HTTP request to the Prometheus scrape endpoint — if our Prometheus port is internal-only, impact is bounded.

**defu** — Prototype pollution via `__proto__` in defaults
- Transitive. Bump.

### MODERATE

**uuid** — Missing buffer bounds check in v3/v5/v6 when buf is provided
- Only affects callers that pass a `buf` argument. Grep confirms we use uuid for short-id generation only, no buffer-arg paths. Bump anyway.

## Recommended action

```bash
cd client
npm audit fix     # apply non-breaking fixes
npm audit         # re-check
npm audit fix --force   # only if first pass leaves criticals + you've vetted breaking changes
```

After the non-force fix:
1. Run the full backend test suite (Mocha) to confirm no behavior regressions.
2. Spot-check the WebSocket relay (`DmService`) since socket.io-parser is in the bump list.
3. Spot-check the OpenTelemetry boot (`instrument.ts`) — a major bump could change the SDK init shape.

For the `--force` pass: probably worth deferring to a focused upgrade sprint rather than a quick fix. Several of the listed packages (effect, opentelemetry stack) have semver-major changes pending.

## What's NOT a concern

- `solidity/` and `smltxt/` — build-time / dev-tooling deps; vulnerabilities there don't reach production runtime. Still worth bumping when convenient but not urgent.
- Bundled CDN assets — not in npm-audit scope; checked separately by the frontend audit.

## Post-fix watch

The opentelemetry CVE is interesting: the Prometheus exporter crash is triggered by an HTTP request to the scrape endpoint. **Verify the Prometheus port is not exposed publicly**. If it is, that's a higher-priority finding than the CVE itself — anyone can crash the metrics process by sending malformed HTTP.

## Did NOT find

No suspicious postinstall scripts, no AWS / API keys committed to `package.json`, no obviously malicious packages (e.g., typosquats of common deps). `cli/` package is clean.
