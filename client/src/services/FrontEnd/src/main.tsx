import './instrument';
import './utils/polyfills';
import { installBfcacheGuard } from './utils/bfcacheGuard';
import { StrictMode } from "react";

// We manage scroll restoration ourselves (per-feed anchors in Feed.tsx).
// Disable the browser's default so it doesn't fight our restore on back/fwd.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// Reaching this line means the main bundle loaded successfully — clear
// the chunk-reload flag so a future post-deploy chunk-404 gets its
// own one-shot reload rather than being silently let through.
// See lazyWithReload in routes.tsx.
try { sessionStorage.removeItem('caw:chunk-reloaded') } catch {}

import { createRoot } from "react-dom/client";
import * as Sentry from '@sentry/react';

import "./index.css";
import "@rainbow-me/rainbowkit/styles.css";
import App from "./App.tsx";
import Web3Provider from "./config/Web3Provider";
import StateProvider from "./config/StateProvider.tsx";
import { IdentitySigningProvider } from "./components/identity/IdentitySigningProvider.tsx";
import { QueryClient, focusManager } from '@tanstack/react-query'

// staleTime tuned for L2 chain reads + API responses. wagmi's
// useReadContract uses this same client, so bumping staleTime cuts
// every duplicate eth_call across components. 5min covers a typical
// session of activity without making fresh data feel old; mutations
// still invalidate the right keys to refresh on demand.
//
// gcTime keeps cached values around for 30min so a return-trip to a
// page (e.g. /home → /caws/1 → /home) reuses the prior fetch.
//
// 30s was burning ~20× the RPC quota an actual user needs.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  },
});

// Hidden-tab gating. React Query's focusManager controls whether
// refetchInterval-based queries (including wagmi block polling)
// actually fire. By default it's tied to window focus + visibility;
// we tighten it to "only fire when the tab is currently visible."
// Without this, opening 20 CAW tabs ran 20 independent poll cycles
// in parallel — each background tab still hit eth_blockNumber on
// pollingInterval and ran any timer-based query refetch. With this,
// only the foreground tab does work; backgrounded tabs go fully
// idle until refocused, then immediately catch up.
//
// refetchOnWindowFocus stays false above so we DON'T fire stale
// queries on every tab switch — only ones that have explicit
// refetchInterval and have crossed it while hidden.
if (typeof document !== 'undefined') {
  const updateFocus = () => focusManager.setFocused(!document.hidden)
  updateFocus()
  document.addEventListener('visibilitychange', updateFocus)
}

// Guard against bfcache restoration onto a stale build. If the SW
// activated a new build while the tab was hidden, the snapshot's chunk
// references may be evicted → blank screen on restore. See bfcacheGuard.ts.
installBfcacheGuard()

// Ctrl+W = delete word back, on any editable surface. The browser's
// default Ctrl+W (close tab) is one of the most-hostile defaults for
// people who came in expecting *nix readline behaviour. We intercept
// it on inputs / textareas / contenteditable and route to a
// word-back delete; if focus is anywhere else, we leave the
// browser's tab-close behaviour alone.
//
// Boundary: whitespace, matching what Option+Backspace does on Mac
// inputs (not punctuation-aware). If there's a selection, deletes
// the selection (also matches Option+Backspace). preventDefault
// always so the tab doesn't close out from under the user when they
// hit the key in an editable field.
if (typeof window !== 'undefined') {
  const isEditableInput = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement => {
    if (!(el instanceof HTMLElement)) return false
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
    if (el instanceof HTMLInputElement) {
      // selectionStart is null for input types that don't support
      // text selection (checkbox, color, range, etc.). Skip those.
      if (el.readOnly || el.disabled) return false
      try { return el.selectionStart !== null } catch { return false }
    }
    return false
  }
  const isContentEditable = (el: EventTarget | null): el is HTMLElement => {
    return el instanceof HTMLElement && el.isContentEditable
  }
  const deleteWordBackInInput = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const value = el.value
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    let newStart = start
    if (start !== end) {
      // Selection present — just delete the selection.
      newStart = Math.min(start, end)
    } else if (start === 0) {
      return // nothing to delete
    } else {
      // Walk back over trailing whitespace, then walk back over the
      // word characters. Whitespace-only is the boundary.
      let i = start
      while (i > 0 && /\s/.test(value[i - 1])) i--
      while (i > 0 && !/\s/.test(value[i - 1])) i--
      newStart = i
    }
    const next = value.slice(0, newStart) + value.slice(Math.max(start, end))
    // React-controlled inputs ignore direct .value writes; use the
    // native setter then dispatch an 'input' event so React's
    // synthetic onChange picks up the change.
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, next)
    } else {
      el.value = next
    }
    el.setSelectionRange(newStart, newStart)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const deleteWordBackInContentEditable = () => {
    const sel = window.getSelection()
    if (!sel) return
    // If there's a range collapsed at cursor, extend it backward
    // by a word; if the range already has a selection, leave it
    // and let execCommand('delete') remove that range.
    if (sel.isCollapsed && typeof sel.modify === 'function') {
      sel.modify('extend', 'backward', 'word')
    }
    // execCommand is deprecated but still works in every browser
    // we ship to and is the only reliable way to perform an
    // editor-aware delete inside a contenteditable that React might
    // be controlling (lexical, slate, etc. listen for beforeinput).
    document.execCommand('delete')
  }
  window.addEventListener('keydown', (e) => {
    // Mac Cmd+W closes the tab and can't be preventDefault'd in
    // any browser; we only handle ctrlKey here. Plain Ctrl+W
    // works on all platforms including Mac.
    if (e.key !== 'w' && e.key !== 'W') return
    if (!e.ctrlKey || e.metaKey || e.altKey) return
    const target = e.target
    if (isEditableInput(target)) {
      e.preventDefault()
      deleteWordBackInInput(target)
    } else if (isContentEditable(target)) {
      e.preventDefault()
      deleteWordBackInContentEditable()
    }
    // If focus isn't on an editable surface, fall through — the
    // browser's tab-close default still applies (Chrome/FF).
  }, { capture: true })
}

// Diagnostic: count how often each query key fires. Enable from the
// browser console with `localStorage.cawRpcDebug = '1'` then refresh.
// Inspect with `__cawRpcCounts` (object keyed by query hash → fire
// count + last-fetched-at). Disable with `localStorage.removeItem`.
// No-op unless explicitly enabled, so production traffic is unaffected.
if (typeof window !== 'undefined' && localStorage.getItem('cawRpcDebug') === '1') {
  const counts: Record<string, { count: number; lastAt: number; key: any }> = {}
  ;(window as any).__cawRpcCounts = counts
  queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated') return
    const action = (event.action as any)?.type
    // 'fetch' fires when a query actually hits the network. (Cache
    // hits don't trigger this — exactly what we want for RPC accounting.)
    if (action !== 'fetch') return
    const hash = event.query.queryHash
    const existing = counts[hash]
    counts[hash] = {
      count: (existing?.count ?? 0) + 1,
      lastAt: Date.now(),
      key: event.query.queryKey,
    }
  })
  console.log('[CAW RPC Debug] enabled — top callers visible at window.__cawRpcCounts')
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong. The error has been reported.</p>}>
      <Web3Provider queryClient={queryClient}>
        <StateProvider>
          <IdentitySigningProvider>
            <App />
          </IdentitySigningProvider>
        </StateProvider>
      </Web3Provider>
    </Sentry.ErrorBoundary>
  </StrictMode>
);
