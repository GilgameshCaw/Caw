/**
 * Unpacks a tight-packed replication payload emitted by CawActionsReplicator.
 *
 * Layout (version 1):
 *   HEADER (4 bytes): uint16 actionCount, uint8 version, uint8 flags
 *   Per action (variable):
 *     uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce,
 *     uint32 clientId, uint32 cawonce,
 *     uint8 recipientCount, uint32[] recipients,
 *     uint8 amountCount, uint64[] amounts,
 *     uint16 textLength, bytes text
 *   Tail: bytes32[] r (32 * actionCount bytes)
 */

export interface UnpackedAction {
  actionType: number
  senderId: number
  receiverId: number
  receiverCawonce: number
  clientId: number
  cawonce: number
  recipients: number[]
  amounts: bigint[]
  text: Uint8Array
}

export interface UnpackedPayload {
  version: number
  flags: number
  actions: UnpackedAction[]
  r: string[]
}

export function unpackReplicationPayload(data: Uint8Array): UnpackedPayload {
  let pos = 0

  function readU8(): number {
    return data[pos++]
  }
  function readU16(): number {
    const v = (data[pos] << 8) | data[pos + 1]
    pos += 2
    return v
  }
  function readU32(): number {
    const v = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]
    pos += 4
    return v >>> 0
  }
  function readU64(): bigint {
    const hi = BigInt(readU32())
    const lo = BigInt(readU32())
    return (hi << 32n) | lo
  }
  function readBytes(len: number): Uint8Array {
    const slice = data.slice(pos, pos + len)
    pos += len
    return slice
  }
  function readBytes32(): string {
    const bytes = readBytes(32)
    return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const actionCount = readU16()
  const version = readU8()
  const flags = readU8()

  if (version !== 1 && version !== 2) throw new Error(`Unsupported packed payload version: ${version}`)

  const actions: UnpackedAction[] = []
  for (let i = 0; i < actionCount; i++) {
    const actionType = readU8()
    const senderId = readU32()
    const receiverId = readU32()
    const receiverCawonce = readU32()
    const clientId = readU32()
    const cawonce = readU32()

    const recipientCount = readU8()
    const recipients: number[] = []
    for (let j = 0; j < recipientCount; j++) recipients.push(readU32())

    const amountCount = readU8()
    const amounts: bigint[] = []
    for (let j = 0; j < amountCount; j++) amounts.push(readU64())

    const textLength = readU16()
    const text = readBytes(textLength)

    actions.push({
      actionType, senderId, receiverId, receiverCawonce,
      clientId, cawonce, recipients, amounts, text,
    })
  }

  // v1 includes r values; v2 omits them (verified on source chain, not needed for recovery)
  const r: string[] = []
  if (version === 1) {
    for (let i = 0; i < actionCount; i++) r.push(readBytes32())
  }

  return { version, flags, actions, r }
}
