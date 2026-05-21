/**
 * ErrorFallback — top-level Sentry.ErrorBoundary fallback rendered when
 * a React render or lifecycle exception escapes any nested boundary.
 *
 * Tries to look like the rest of the app rather than a stark "the page is
 * broken" message, while still giving the user a way to retry (reload) and
 * making clear the error has been reported.
 */
import { HiExclamationCircle } from 'react-icons/hi'

export function ErrorFallback() {
  const handleReload = () => {
    // Force a hard reload — bypasses any half-broken React state.
    window.location.reload()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)',
        padding: '2rem',
      }}
    >
      <div
        style={{
          maxWidth: '480px',
          width: '100%',
          textAlign: 'center',
          color: '#f5f5f5',
        }}
      >
        <HiExclamationCircle
          size={64}
          style={{ color: '#facc15', margin: '0 auto 1.5rem', display: 'block' }}
        />
        <h1
          style={{
            fontSize: '1.75rem',
            fontWeight: 600,
            marginBottom: '0.75rem',
            color: '#fff',
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            fontSize: '1rem',
            color: '#a3a3a3',
            marginBottom: '2rem',
            lineHeight: 1.5,
          }}
        >
          The error has been reported. Try reloading — if it keeps happening,
          we'll look into it.
        </p>
        <button
          type="button"
          onClick={handleReload}
          style={{
            background: '#facc15',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: '8px',
            padding: '0.75rem 2rem',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'transform 80ms ease-out',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)' }}
        >
          Reload the page
        </button>
      </div>
    </div>
  )
}
