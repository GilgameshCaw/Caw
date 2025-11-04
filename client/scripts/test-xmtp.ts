#!/usr/bin/env tsx

import { Client, type Signer, IdentifierKind } from '@xmtp/node-sdk'
import { ethers } from 'ethers'
import crypto from 'crypto'

async function testXmtpClient() {
  console.log('Testing XMTP Node SDK v4 client initialization...')

  try {
    // Create a test wallet
    const wallet = ethers.Wallet.createRandom()
    console.log('Test wallet address:', wallet.address)

    // Generate encryption key for database
    const dbEncryptionKey = crypto.randomBytes(32)
    console.log('Generated encryption key:', dbEncryptionKey.length, 'bytes')

    // Create a Signer object that XMTP v4 expects
    const signer: Signer = {
      type: "EOA",
      getIdentifier: () => ({
        identifier: wallet.address.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum
      }),
      signMessage: async (message: string) => {
        console.log('Signing message:', message.substring(0, 50) + '...')
        const signature = await wallet.signMessage(message)
        // Convert hex signature to Uint8Array
        const hexString = signature.startsWith('0x') ? signature.slice(2) : signature
        const bytes = new Uint8Array(
          hexString.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
        )
        return bytes
      }
    }

    // Create XMTP client with proper v4 signer
    console.log('Creating XMTP client with v4 signer...')
    const client = await Client.create(signer, {
      dbEncryptionKey,
      env: 'dev'
    })

    console.log('✅ XMTP client created successfully!')
    console.log('Client instance:', client)
    // The inbox ID is already displayed during client creation

    // Test conversation capabilities
    console.log('\nTesting conversation capabilities...')
    const canMessageSelf = await client.canMessage([wallet.address])
    console.log('Can message self:', canMessageSelf.get(wallet.address.toLowerCase()))

    // List conversations
    const conversations = await client.conversations.list()
    console.log('Number of conversations:', conversations.length)

    console.log('\n✅ All tests passed!')

  } catch (error) {
    console.error('❌ Error:', error)
    if (error instanceof Error) {
      console.error('Error message:', error.message)
      console.error('Error stack:', error.stack)
    }
  }
}

testXmtpClient()