/**
 * Packs action data into the tight binary format expected by CawActions.processActions.
 *
 * Packed layout:
 *   [2 bytes] uint16 actionCount
 *   Per action:
 *     [1]   actionType
 *     [4]   senderId
 *     [4]   receiverId
 *     [4]   receiverCawonce
 *     [4]   clientId
 *     [4]   cawonce
 *     [1]   recipientCount (N)
 *     [1]   amountCount (M) — as signed (0, N, or N+1)
 *     [4*N] recipients
 *     [8*M] amounts
 *     [2]   textLength
 *     [T]   text bytes
 *
 * Sigs layout: concatenated per-action [1 v, 32 r, 32 s] = 65 bytes each
 */

interface ActionForPacking {
  actionType: number
  senderId: number
  receiverId: number
  receiverCawonce: number
  clientId: number
  cawonce: number
  recipients: number[]
  amounts: (bigint | string | number)[]
  text: string // hex-encoded bytes (0x...)
}

export function packActions(actions: ActionForPacking[]): Uint8Array {
  // First pass: compute total size
  let size = 2 // actionCount header
  for (const a of actions) {
    const rc = a.recipients?.length || 0
    const ac = a.amounts?.length || 0
    const textBytes = hexToBytes(a.text || '0x')
    size += 21 + 1 + 1 + (rc * 4) + (ac * 8) + 2 + textBytes.length
  }

  const buf = new Uint8Array(size)
  let pos = 0

  // Header
  buf[pos++] = (actions.length >> 8) & 0xFF
  buf[pos++] = actions.length & 0xFF

  for (const a of actions) {
    // actionType
    buf[pos++] = a.actionType & 0xFF

    // uint32 fields (big-endian)
    writeU32(buf, pos, a.senderId); pos += 4
    writeU32(buf, pos, a.receiverId || 0); pos += 4
    writeU32(buf, pos, a.receiverCawonce || 0); pos += 4
    writeU32(buf, pos, a.clientId); pos += 4
    writeU32(buf, pos, a.cawonce); pos += 4

    // Recipients + amounts counts
    const rc = a.recipients?.length || 0
    const amounts = a.amounts || []
    const ac = amounts.length
    buf[pos++] = rc
    buf[pos++] = ac
    for (let j = 0; j < rc; j++) {
      writeU32(buf, pos, a.recipients[j]); pos += 4
    }

    // Amounts: exact count as signed
    for (let j = 0; j < ac; j++) {
      const val = BigInt(amounts[j])
      writeU64(buf, pos, val); pos += 8
    }

    // Text
    const textBytes = hexToBytes(a.text || '0x')
    buf[pos++] = (textBytes.length >> 8) & 0xFF
    buf[pos++] = textBytes.length & 0xFF
    buf.set(textBytes, pos)
    pos += textBytes.length
  }

  return buf
}

export function packSignatures(
  signatures: Array<{ v: number; r: string; s: string }>
): Uint8Array {
  const buf = new Uint8Array(signatures.length * 65)
  for (let i = 0; i < signatures.length; i++) {
    const off = i * 65
    buf[off] = signatures[i].v
    const rBytes = hexToBytes(signatures[i].r)
    const sBytes = hexToBytes(signatures[i].s)
    buf.set(rBytes, off + 1)
    buf.set(sBytes, off + 33)
  }
  return buf
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex === '0x') return new Uint8Array(0)
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (h.length === 0) return new Uint8Array(0)
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function writeU32(buf: Uint8Array, pos: number, v: number) {
  buf[pos] = (v >>> 24) & 0xFF
  buf[pos + 1] = (v >>> 16) & 0xFF
  buf[pos + 2] = (v >>> 8) & 0xFF
  buf[pos + 3] = v & 0xFF
}

function writeU64(buf: Uint8Array, pos: number, v: bigint) {
  const hi = Number(v >> 32n) >>> 0
  const lo = Number(v & 0xFFFFFFFFn) >>> 0
  writeU32(buf, pos, hi)
  writeU32(buf, pos + 4, lo)
}

/**
 * Unpack actions from the packed binary format.
 */
export function unpackActions(packed: Uint8Array): ActionForPacking[] {
  const actionCount = (packed[0] << 8) | packed[1]
  const actions: ActionForPacking[] = []
  let pos = 2

  for (let i = 0; i < actionCount; i++) {
    const actionType = packed[pos++]
    const senderId = readU32BE(packed, pos); pos += 4
    const receiverId = readU32BE(packed, pos); pos += 4
    const receiverCawonce = readU32BE(packed, pos); pos += 4
    const clientId = readU32BE(packed, pos); pos += 4
    const cawonce = readU32BE(packed, pos); pos += 4
    const rc = packed[pos++]
    const ac = packed[pos++]
    const recipients: number[] = []
    for (let j = 0; j < rc; j++) { recipients.push(readU32BE(packed, pos)); pos += 4 }
    const amounts: bigint[] = []
    for (let j = 0; j < ac; j++) { amounts.push(readU64BE(packed, pos)); pos += 8 }
    const tl = (packed[pos] << 8) | packed[pos + 1]; pos += 2
    const text = bytesToHex(packed.slice(pos, pos + tl)); pos += tl
    actions.push({ actionType, senderId, receiverId, receiverCawonce, clientId, cawonce, recipients, amounts, text })
  }
  return actions
}

function readU32BE(buf: Uint8Array, pos: number): number {
  return ((buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3]) >>> 0
}

function readU64BE(buf: Uint8Array, pos: number): bigint {
  const hi = BigInt(readU32BE(buf, pos))
  const lo = BigInt(readU32BE(buf, pos + 4))
  return (hi << 32n) | lo
}

/**
 * Compute keccak256 of each action's packed slice from the packed buffer.
 * Used for pre-flight hash chain verification.
 */
export function getPackedActionSlices(packed: Uint8Array): Uint8Array[] {
  const actionCount = (packed[0] << 8) | packed[1]
  const slices: Uint8Array[] = []
  let pos = 2

  for (let i = 0; i < actionCount; i++) {
    const start = pos
    pos += 21 // fixed fields
    const rc = packed[pos++]
    const ac = packed[pos++]
    pos += rc * 4            // recipients
    pos += ac * 8            // amounts
    const tl = (packed[pos] << 8) | packed[pos + 1]
    pos += 2 + tl            // textLength + text
    slices.push(packed.slice(start, pos))
  }

  return slices
}
