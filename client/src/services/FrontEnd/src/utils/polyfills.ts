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

export {}