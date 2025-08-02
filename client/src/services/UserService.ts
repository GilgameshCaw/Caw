import { prisma } from '../prismaClient'
import { CAW_NAMES_ADDRESS } from '../abi/addresses'
import { Contract, JsonRpcProvider } from 'ethers'

const CawNameAbi = [
  'function tokenURI(uint256 tokenId) view returns (string)'
]

const mainnetProvider = new JsonRpcProvider(process.env.MAINNET_RPC_URL)
const nameContract  = new Contract(
  CAW_NAMES_ADDRESS,
  CawNameAbi,
  mainnetProvider
)

/**
 * findOrCreateUser
 * - uses on‑chain senderId as both L2 address and NFT tokenId
 */
export async function findOrCreateUser(senderId: number) {
  const tokenId = senderId;
  if (tokenId === 0) {
    throw new Error("senderId cannot be zero");
  }

  let user = await prisma.user.findUnique({
    where: { tokenId: senderId }
  })

  if (!user) {
    // pull your on‑chain metadata
    const uri  = await nameContract.tokenURI(tokenId);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));

    // atomic create‑or‑return
    user = await prisma.user.upsert({
      where:  { tokenId },
      update: {},           // no changes if it already exists
      create: {
        address:  String(senderId),
        tokenId,
        username: json.name,
        image:    json.image,
      },
    });
  }

  return user.id;
}


/**
 * enrichUser
 * - calls mainnet tokenURI, decodes base64 JSON, writes username+image
 */
async function enrichUser(userId: number, tokenId: number) {
  try {
    const uri = await nameContract.tokenURI(tokenId)
    const b64 = uri.split(',')[1]
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    await prisma.user.update({
      where: { id: userId },
      data: { username: json.name, image: json.image }
    })
  } catch (err: any) {
    console.warn(`no mainnet NFT yet for tokenId=${tokenId}`)
  }
}

