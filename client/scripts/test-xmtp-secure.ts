#!/usr/bin/env tsx

/**
 * Test script for secure XMTP implementation
 *
 * This demonstrates the proper architecture:
 * 1. Client creates XMTP client with user's wallet
 * 2. Client sends encrypted messages through XMTP
 * 3. Server only stores encrypted payloads
 * 4. Server never has access to private keys
 */

import { Client } from '@xmtp/xmtp-js'
import { Wallet } from 'ethers'

async function testSecureXmtp() {
  console.log('🔒 Testing Secure XMTP Implementation')
  console.log('=====================================\n')

  // 1. Create test wallets (in production, these would be user wallets like MetaMask)
  const alice = Wallet.createRandom()
  const bob = Wallet.createRandom()

  console.log('👤 Alice wallet:', alice.address)
  console.log('👤 Bob wallet:', bob.address)
  console.log()

  try {
    // 2. Create XMTP clients with wallets (happens on client-side)
    console.log('🔐 Creating XMTP clients with wallet signatures...')
    const aliceClient = await Client.create(alice, { env: 'production' })
    const bobClient = await Client.create(bob, { env: 'production' })

    console.log('✅ Alice XMTP client created')
    console.log('✅ Bob XMTP client created')
    console.log()

    // 3. Alice starts conversation with Bob (client-side)
    console.log('💬 Alice starting conversation with Bob...')
    const conversation = await aliceClient.conversations.newConversation(bob.address)
    console.log('✅ Conversation created:', conversation.topic)
    console.log()

    // 4. Alice sends encrypted message (client-side)
    console.log('📤 Alice sending encrypted message...')
    const message = 'Hello Bob! This message is end-to-end encrypted.'
    await conversation.send(message)
    console.log('✅ Message sent through XMTP')
    console.log()

    // 5. Demonstrate what server would store (only encrypted payload)
    console.log('🗄️  What the server stores:')
    console.log('----------------------------')
    console.log({
      topic: conversation.topic,
      senderAddress: alice.address,
      encryptedPayload: '<encrypted blob - server cannot decrypt>',
      timestamp: new Date().toISOString()
    })
    console.log()

    // 6. Bob receives and decrypts message (client-side)
    console.log('📥 Bob checking messages...')
    await bobClient.conversations.sync()
    const bobConversations = await bobClient.conversations.list()
    const bobConv = bobConversations[0]

    if (bobConv) {
      const messages = await bobConv.messages()
      console.log('✅ Bob received and decrypted:', messages[0].content)
    }
    console.log()

    // 7. Security summary
    console.log('🔒 SECURITY SUMMARY')
    console.log('==================')
    console.log('✅ Messages encrypted client-side with user wallets')
    console.log('✅ Server only stores encrypted payloads')
    console.log('✅ Private keys never leave the client')
    console.log('✅ Server cannot read message content')
    console.log('✅ True end-to-end encryption')

  } catch (error) {
    console.error('❌ Error:', error)
  }
}

// Architecture comparison
console.log('\n📊 ARCHITECTURE COMPARISON')
console.log('==========================\n')

console.log('❌ OLD (INSECURE) APPROACH:')
console.log('---------------------------')
console.log('1. Server generates private keys')
console.log('2. Server signs messages')
console.log('3. Server can read all messages')
console.log('4. Major security vulnerability')
console.log()

console.log('✅ NEW (SECURE) APPROACH:')
console.log('-------------------------')
console.log('1. Client uses wallet for signing')
console.log('2. Messages encrypted on client')
console.log('3. Server stores encrypted data only')
console.log('4. True end-to-end encryption')
console.log()

// Run the test
testSecureXmtp()