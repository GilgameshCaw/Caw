import { privateKeyToAccount } from "viem/accounts"
import { bytesToHex } from "viem"
import SmlTxt from "smltxt"

let _smlTxt: SmlTxt | undefined
function getSmlTxt(): SmlTxt {
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  return _smlTxt
}

function compressText(text: string): `0x${string}` {
  if (!text) return "0x"
  return bytesToHex(getSmlTxt().compress(text))
}

const ActionTypeMap = {
  caw: 0,
  like: 1,
  unlike: 2,
  recaw: 3,
  follow: 4,
  unfollow: 5,
} as const

type SocialAction = keyof typeof ActionTypeMap

const TYPES = {
  ActionData: [
    { name: "actionType", type: "uint8" },
    { name: "senderId", type: "uint32" },
    { name: "receiverId", type: "uint32" },
    { name: "receiverCawonce", type: "uint32" },
    { name: "clientId", type: "uint32" },
    { name: "cawonce", type: "uint32" },
    { name: "recipients", type: "uint32[]" },
    { name: "amounts", type: "uint64[]" },
    { name: "text", type: "bytes" },
  ],
} as const

export interface SignedAction {
  data: Record<string, unknown>
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string; type: string }[]>
  signature: `0x${string}`
}

export async function signAction(opts: {
  sessionKey: `0x${string}`
  chainId: number
  verifyingContract: `0x${string}`
  senderId: number
  clientId: number
  cawonce: number
  actionType: SocialAction
  receiverId?: number
  receiverCawonce?: number
  text?: string
  tip?: bigint
}): Promise<SignedAction> {
  const domain = {
    name: "Caw Protocol",
    version: "1",
    chainId: opts.chainId,
    verifyingContract: opts.verifyingContract,
  }

  const tip = opts.tip ?? 0n
  const message = {
    actionType: ActionTypeMap[opts.actionType],
    senderId: opts.senderId,
    receiverId: opts.receiverId ?? 0,
    receiverCawonce: opts.receiverCawonce ?? 0,
    clientId: opts.clientId,
    cawonce: opts.cawonce,
    recipients: [] as number[],
    amounts: [tip],
    text: compressText(opts.text ?? ""),
  }

  const account = privateKeyToAccount(opts.sessionKey)
  const signature = await account.signTypedData({
    domain,
    types: TYPES,
    primaryType: "ActionData",
    message,
  })

  const apiMessage = { ...message, amounts: message.amounts.map(String) }
  return { data: apiMessage, domain, types: TYPES, signature }
}
