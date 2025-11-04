import { prisma } from '../src/prismaClient'
import { CAW_NAMES_L2_ADDRESS } from '../src/abi/addresses'
import { Contract, JsonRpcProvider } from 'ethers'

const CawNameAbi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
]

async function setupProvider() {
  // Try local devL2 network first, fallback to Base Sepolia
  try {
    const l2Provider = new JsonRpcProvider('http://localhost:8546')
    await l2Provider.getBlockNumber()
    console.log('✓ Using local devL2 network (localhost:8546)')
    return { provider: l2Provider, address: CAW_NAMES_L2_ADDRESS }
  } catch {
    // Fallback to Base Sepolia
    const l2Provider = new JsonRpcProvider('https://sepolia.base.org')
    console.log('✓ Using Base Sepolia')
    return { provider: l2Provider, address: CAW_NAMES_L2_ADDRESS }
  }
}

async function fixUserData() {
  const { provider, address } = await setupProvider()
  const nameContract = new Contract(address, CawNameAbi, provider)
  console.log('Fetching all users...')
  const users = await prisma.user.findMany()

  console.log(`Found ${users.length} users to fix`)

  for (const user of users) {
    console.log(`\nProcessing user ${user.id} (tokenId: ${user.tokenId})`)
    console.log(`  Current address: ${user.address}`)
    console.log(`  Current username: ${user.username}`)

    try {
      // Query blockchain for correct data
      const [uri, ownerAddress] = await Promise.all([
        nameContract.tokenURI(user.tokenId),
        nameContract.ownerOf(user.tokenId)
      ])

      const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"))

      console.log(`  ✓ Blockchain data:`)
      console.log(`    - Owner address: ${ownerAddress}`)
      console.log(`    - Username: ${json.name}`)
      console.log(`    - Image: ${json.image}`)

      // Update user with correct data
      await prisma.user.update({
        where: { id: user.id },
        data: {
          address: ownerAddress.toLowerCase(),
          username: json.name,
          image: json.image
        }
      })

      console.log(`  ✓ Updated successfully`)

    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}`)
    }
  }

  console.log('\n✅ Done!')
}

fixUserData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
