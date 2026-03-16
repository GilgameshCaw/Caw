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
  // Create mock FileSystemDirectoryHandle
  const createMockHandle = (): any => {
    const mockHandle: any = {
      kind: 'directory',
      name: 'xmtp-storage',
      isDirectory: true,
      isFile: false,

      getFileHandle: async (name: string, options?: any) => {
        return {
          kind: 'file',
          name,
          getFile: async () => new Blob(),
          createWritable: async () => ({
            write: async (data: any) => {},
            close: async () => {},
            seek: async (position: number) => {},
            truncate: async (size: number) => {}
          })
        }
      },

      getDirectoryHandle: async (name: string, options?: any) => {
        return createMockHandle(); // Return new mock for nested directories
      },

      removeEntry: async (name: string, options?: any) => {},

      resolve: async (possibleDescendant: any) => null,

      values: async function* () {},

      keys: async function* () {},

      entries: async function* () {}
    };

    // Make it iterable
    mockHandle[Symbol.asyncIterator] = mockHandle.entries;
    return mockHandle;
  };

  // Force create navigator.storage if it doesn't exist
  if (!navigator.storage) {
    try {
      Object.defineProperty(navigator, 'storage', {
        value: {
          getDirectory: async () => createMockHandle()
        },
        writable: false,
        configurable: true
      });
    } catch (e) {
      // Ignore errors
    }
  } else if (typeof navigator.storage.getDirectory !== 'function') {
    // navigator.storage exists but doesn't have getDirectory
    try {
      Object.defineProperty(navigator.storage, 'getDirectory', {
        value: async () => createMockHandle(),
        writable: false,
        configurable: true
      });
    } catch (e) {
      // Ignore errors
    }
  }
}

export {}