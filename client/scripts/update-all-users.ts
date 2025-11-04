import { prisma } from '../src/prismaClient'
import { CAW_NAMES_L2_ADDRESS, CAW_NAMES_ADDRESS } from '../src/abi/addresses'
import { Contract, WebSocketProvider } from 'ethers'

const CawNameL2Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)'
]

const CawNameL1Abi = [
  'function usernames(uint256 index) view returns (string)'
]

const l2Provider = new WebSocketProvider('wss://base-sepolia.infura.io/ws/v3/YOUR_INFURA_PROJECT_ID')
const l2NameContract = new Contract(CAW_NAMES_L2_ADDRESS, CawNameL2Abi, l2Provider)

const l1Provider = new WebSocketProvider('wss://eth-sepolia.g.alchemy.com/v2/demo')
const l1NameContract = new Contract(CAW_NAMES_ADDRESS, CawNameL1Abi, l1Provider)

async function updateAllUsers() {
  console.log('Fetching all users from database...')
  const users = await prisma.user.findMany({
    orderBy: { tokenId: 'asc' }
  })

  console.log(`Found ${users.length} users to update\n`)

  let successCount = 0
  let errorCount = 0

  for (const user of users) {
    console.log(`\n[User ${user.id}] TokenId: ${user.tokenId}`)
    console.log(`  Current address: ${user.address}`)
    console.log(`  Current username: ${user.username}`)

    try {
      // Query L2 for owner address and L1 for username
      const [ownerAddress, username] = await Promise.all([
        l2NameContract.ownerOf(user.tokenId),
        l1NameContract.usernames(user.tokenId - 1) // usernames array is 0-indexed
      ])

      console.log(`  ✓ Blockchain data:`)
      console.log(`    - Owner: ${ownerAddress}`)
      console.log(`    - Username: ${username}`)

      // Validate username exists
      if (!username || username.trim() === '') {
        console.error(`  ✗ Error: Username not set on L1 contract`)
        errorCount++
        continue
      }

      // Update user with correct data
      await prisma.user.update({
        where: { id: user.id },
        data: {
          address: ownerAddress.toLowerCase(),
          username: username.trim()
        }
      })

      console.log(`  ✓ Updated successfully`)
      successCount++

    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}`)
      errorCount++
    }
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Update complete!`)
  console.log(`  ✓ Success: ${successCount}`)
  console.log(`  ✗ Errors: ${errorCount}`)
  console.log(`${'='.repeat(50)}`)
}

updateAllUsers()
  .then(() => {
    l2Provider.destroy()
    l1Provider.destroy()
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
