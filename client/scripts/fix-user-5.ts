import 'dotenv/config'
import { prisma } from '../src/prismaClient'
import { CAW_NAMES_L2_ADDRESS } from '../src/abi/addresses'
import { Contract, WebSocketProvider } from 'ethers'

const CawProfileAbi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
]

const l2RpcUrl = process.env.L2_RPC_URL
if (!l2RpcUrl) {
  console.error('Missing L2_RPC_URL in environment variables')
  process.exit(1)
}

const l2Provider = new WebSocketProvider(l2RpcUrl)
const nameContract = new Contract(CAW_NAMES_L2_ADDRESS, CawProfileAbi, l2Provider)

async function fixUser5() {
  const tokenId = 5

  console.log(`Fetching blockchain data for tokenId ${tokenId}...`)

  try {
    const [uri, ownerAddress] = await Promise.all([
      nameContract.tokenURI(tokenId),
      nameContract.ownerOf(tokenId)
    ])

    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"))

    console.log(`\nBlockchain data:`)
    console.log(`  Owner: ${ownerAddress}`)
    console.log(`  Username: ${json.name}`)
    console.log(`  Image: ${json.image}`)

    console.log(`\nUpdating user in database...`)
    await prisma.user.update({
      where: { tokenId },
      data: {
        address: ownerAddress.toLowerCase(),
        username: json.name,
        image: json.image
      }
    })

    console.log(`✓ User ${tokenId} updated successfully!`)

  } catch (err: any) {
    console.error(`✗ Error: ${err.message}`)
    throw err
  } finally {
    await l2Provider.destroy()
  }
}

fixUser5()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
