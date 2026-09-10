/**
 * NodeConfigError — full-screen fallback shown when CLIENT_ID (the network id
 * baked into the bundle from VITE_NETWORK_ID) isn't a usable value.
 *
 * CLIENT_ID_VALID is false only when a bundle was built without a valid
 * VITE_NETWORK_ID. Rather than let the app mount and have every contract read
 * and every EIP-712 signing hit a NaN/0 CLIENT_ID -- which surfaces as WebKit's
 * opaque "Not an integer" at sign time -- App gates on it and renders this,
 * so the failure is legible and points at the fix. Modeled on ErrorFallback so
 * a misconfigured node looks like a stated error, not a crash.
 */
import { HiExclamationCircle } from 'react-icons/hi'
import { CLIENT_ID } from '~/api/actions'

const code: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  background: '#ffffff14', padding: '0.1rem 0.35rem', borderRadius: '4px', color: '#e5e5e5',
}

export function NodeConfigError() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)', padding: '2rem' }}>
      <div style={{ maxWidth: '520px', width: '100%', textAlign: 'center', color: '#f5f5f5' }}>
        <HiExclamationCircle size={64} style={{ color: '#facc15', margin: '0 auto 1.5rem', display: 'block' }} />
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, marginBottom: '0.75rem', color: '#fff' }}>
          Node configuration error
        </h1>
        <p style={{ fontSize: '1rem', color: '#a3a3a3', marginBottom: '1.5rem', lineHeight: 1.5 }}>
          This build has no valid network id. <span style={code}>VITE_NETWORK_ID</span> was
          missing or invalid when the frontend was built, so <span style={code}>CLIENT_ID</span> resolved
          to <span style={code}>{String(CLIENT_ID)}</span>. Every on-chain action would fail signing.
        </p>
        <p style={{ fontSize: '0.875rem', color: '#737373', lineHeight: 1.5 }}>
          Set <span style={code}>VITE_NETWORK_ID</span> in <span style={code}>client/src/services/FrontEnd/.env</span> and rebuild.
        </p>
      </div>
    </div>
  )
}
