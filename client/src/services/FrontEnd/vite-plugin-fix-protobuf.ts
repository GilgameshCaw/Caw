import type { Plugin } from 'vite'

/**
 * Vite plugin to fix protobufjs imports for @xmtp/proto
 */
export function fixProtobufPlugin(): Plugin {
  return {
    name: 'fix-protobuf-imports',
    enforce: 'pre',

    resolveId(id) {
      if (id === 'protobufjs/minimal' || id === 'protobufjs/minimal.js') {
        // Return a virtual module ID
        return '\0protobufjs-minimal-wrapper'
      }
    },

    load(id) {
      if (id === '\0protobufjs-minimal-wrapper') {
        // Re-export protobuf with both default and named exports
        // Manually initialize protobuf.util.Long with the Long library
        return `
import * as _protobuf from 'protobufjs/minimal.js';
import Long from 'long';

// Initialize Long in protobuf if not already set
if (_protobuf.util && !_protobuf.util.Long) {
  _protobuf.util.Long = Long;
  _protobuf.configure();
}

export * from 'protobufjs/minimal.js';
export default _protobuf;
        `.trim()
      }
    }
  }
}
