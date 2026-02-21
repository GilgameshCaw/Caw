/**
 * Browser polyfills for Node.js modules used by XMTP
 */

// Buffer polyfill
import { Buffer } from 'buffer'
import * as protobuf from 'protobufjs/minimal'
import Long from 'long'

// Make Buffer available globally
if (typeof window !== 'undefined' && typeof window.Buffer === 'undefined') {
  window.Buffer = Buffer
  ;(window as any).global = window
}

// Initialize protobuf with Long
if (protobuf.util && protobuf.util.Long !== Long) {
  protobuf.util.Long = Long as any
  protobuf.configure()
}

// Storage API polyfill for XMTP
if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
  console.log('[Polyfill] Initializing storage API polyfills...');
  console.log('[Polyfill] Cross-origin isolated?', window.crossOriginIsolated);
  console.log('[Polyfill] Current navigator.storage:', navigator.storage);
  console.log('[Polyfill] Has getDirectory?', typeof navigator.storage?.getDirectory);

  // Critical check: OPFS requires cross-origin isolation
  if (!window.crossOriginIsolated) {
    console.error('[Polyfill] ⚠️  Cross-origin isolation is NOT enabled!');
    console.error('[Polyfill] OPFS will not work. Check that these headers are set:');
    console.error('[Polyfill] - Cross-Origin-Embedder-Policy: require-corp');
    console.error('[Polyfill] - Cross-Origin-Opener-Policy: same-origin');
    console.error('[Polyfill] You may need to do a hard refresh (Cmd+Shift+R)');
  }

  // Create mock FileSystemDirectoryHandle
  const createMockHandle = (): any => {
    const mockHandle: any = {
      kind: 'directory',
      name: 'xmtp-storage',
      isDirectory: true,
      isFile: false,

      getFileHandle: async (name: string, options?: any) => {
        console.log('[Polyfill] getFileHandle called:', name);
        return {
          kind: 'file',
          name,
          getFile: async () => new Blob(),
          createWritable: async () => ({
            write: async (data: any) => {
              console.log('[Polyfill] write called');
            },
            close: async () => {
              console.log('[Polyfill] close called');
            },
            seek: async (position: number) => {},
            truncate: async (size: number) => {}
          })
        }
      },

      getDirectoryHandle: async (name: string, options?: any) => {
        console.log('[Polyfill] getDirectoryHandle called:', name);
        return createMockHandle(); // Return new mock for nested directories
      },

      removeEntry: async (name: string, options?: any) => {
        console.log('[Polyfill] removeEntry called:', name);
      },

      resolve: async (possibleDescendant: any) => {
        console.log('[Polyfill] resolve called');
        return null;
      },

      values: async function* () {
        console.log('[Polyfill] values called');
      },

      keys: async function* () {
        console.log('[Polyfill] keys called');
      },

      entries: async function* () {
        console.log('[Polyfill] entries called');
      }
    };

    // Make it iterable
    mockHandle[Symbol.asyncIterator] = mockHandle.entries;
    return mockHandle;
  };

  // Force create navigator.storage if it doesn't exist
  if (!navigator.storage) {
    console.log('[Polyfill] navigator.storage is undefined, creating...');
    try {
      Object.defineProperty(navigator, 'storage', {
        value: {
          getDirectory: async () => {
            console.log('[Polyfill] getDirectory called via created storage');
            return createMockHandle();
          }
        },
        writable: false,
        configurable: true
      });
      console.log('[Polyfill] Created navigator.storage with getDirectory');
    } catch (e) {
      console.error('[Polyfill] Failed to create navigator.storage:', e);
    }
  } else if (typeof navigator.storage.getDirectory !== 'function') {
    // navigator.storage exists but doesn't have getDirectory
    console.log('[Polyfill] navigator.storage exists but missing getDirectory, adding...');
    try {
      Object.defineProperty(navigator.storage, 'getDirectory', {
        value: async () => {
          console.log('[Polyfill] getDirectory called via added method');
          return createMockHandle();
        },
        writable: false,
        configurable: true
      });
      console.log('[Polyfill] Added getDirectory to existing navigator.storage');
    } catch (e) {
      console.error('[Polyfill] Failed to add getDirectory:', e);
    }
  } else {
    console.log('[Polyfill] navigator.storage.getDirectory already exists');
  }

  // Verify it worked
  console.log('[Polyfill] Final check - navigator.storage:', navigator.storage);
  console.log('[Polyfill] Final check - getDirectory type:', typeof navigator.storage?.getDirectory);

  // Ensure crypto.subtle exists
  if (!window.crypto?.subtle) {
    console.warn('[Polyfill] crypto.subtle not available - XMTP may not work properly')
  }

  console.log('[Polyfill] Storage API polyfills loaded successfully');
}

export {}