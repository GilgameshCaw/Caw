#!/usr/bin/env node

/**
 * Test script for XMTP integration
 * This script verifies that all XMTP features are working correctly
 */

const API_BASE = 'http://localhost:4000/api';
const TEST_USER_1 = { tokenId: 1, username: 'testuser1' };
const TEST_USER_2 = { tokenId: 2, username: 'testuser2' };

// Test wallet addresses (for demo purposes)
const WALLET_1 = '0x' + '1'.repeat(40);
const WALLET_2 = '0x' + '2'.repeat(40);

// Generate a simple auth token for testing
function generateToken(userId) {
  return Buffer.from(JSON.stringify({ userId, exp: Date.now() + 86400000 })).toString('base64');
}

async function testEndpoint(name, method, url, options = {}) {
  console.log(`\n📝 Testing: ${name}`);
  console.log(`   ${method} ${url}`);

  try {
    const response = await fetch(url, {
      method,
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`   ✅ Success:`, data.success ? 'true' : data);
      return data;
    } else {
      console.log(`   ❌ Error:`, data.error || response.statusText);
      return null;
    }
  } catch (error) {
    console.log(`   ❌ Failed:`, error.message);
    return null;
  }
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('🧪 XMTP Integration Test Suite');
  console.log('='.repeat(60));

  const token1 = generateToken(TEST_USER_1.tokenId);
  const token2 = generateToken(TEST_USER_2.tokenId);

  // Test 1: Register XMTP Identity for User 1
  await testEndpoint(
    'Register XMTP Identity - User 1',
    'POST',
    `${API_BASE}/xmtp/identity/register`,
    {
      headers: { Authorization: `Bearer ${token1}` },
      body: JSON.stringify({
        tokenId: TEST_USER_1.tokenId,
        walletAddress: WALLET_1
      })
    }
  );

  // Test 2: Register XMTP Identity for User 2
  await testEndpoint(
    'Register XMTP Identity - User 2',
    'POST',
    `${API_BASE}/xmtp/identity/register`,
    {
      headers: { Authorization: `Bearer ${token2}` },
      body: JSON.stringify({
        tokenId: TEST_USER_2.tokenId,
        walletAddress: WALLET_2
      })
    }
  );

  // Test 3: Get XMTP Identity
  await testEndpoint(
    'Get XMTP Identity',
    'GET',
    `${API_BASE}/xmtp/identity/${TEST_USER_1.tokenId}`,
    {
      headers: { Authorization: `Bearer ${token1}` }
    }
  );

  // Test 4: Create Conversation
  const conversation = await testEndpoint(
    'Create DM Conversation',
    'POST',
    `${API_BASE}/xmtp/conversations`,
    {
      headers: { Authorization: `Bearer ${token1}` },
      body: JSON.stringify({
        creatorId: TEST_USER_1.tokenId,
        participantIds: [TEST_USER_2.tokenId],
        type: 'DM',
        name: 'Test Conversation'
      })
    }
  );

  if (conversation && conversation.conversation) {
    const conversationId = conversation.conversation.id;

    // Test 5: Send Message
    await testEndpoint(
      'Send Message',
      'POST',
      `${API_BASE}/xmtp/messages`,
      {
        headers: { Authorization: `Bearer ${token1}` },
        body: JSON.stringify({
          conversationId,
          senderId: TEST_USER_1.tokenId,
          content: 'Hello from test!',
          contentType: 'text'
        })
      }
    );

    // Test 6: Get Messages
    await testEndpoint(
      'Get Messages',
      'GET',
      `${API_BASE}/xmtp/conversations/${conversationId}/messages?userId=${TEST_USER_2.tokenId}`,
      {
        headers: { Authorization: `Bearer ${token2}` }
      }
    );

    // Test 7: Mark Messages as Read
    await testEndpoint(
      'Mark Messages as Read',
      'POST',
      `${API_BASE}/xmtp/messages/read`,
      {
        headers: { Authorization: `Bearer ${token2}` },
        body: JSON.stringify({
          messageIds: ['test-id-1'],
          userId: TEST_USER_2.tokenId
        })
      }
    );
  }

  // Test 8: Get Conversations
  await testEndpoint(
    'Get Conversations',
    'GET',
    `${API_BASE}/xmtp/conversations?userId=${TEST_USER_1.tokenId}`,
    {
      headers: { Authorization: `Bearer ${token1}` }
    }
  );

  // Test 9: Search Messages
  await testEndpoint(
    'Search Messages',
    'GET',
    `${API_BASE}/xmtp/messages/search?userId=${TEST_USER_1.tokenId}&from=2025-01-01&to=2025-12-31`,
    {
      headers: { Authorization: `Bearer ${token1}` }
    }
  );

  // Test 10: File Upload (mock)
  console.log(`\n📝 Testing: File Upload`);
  console.log(`   POST ${API_BASE}/xmtp/messages/upload`);
  console.log(`   ⚠️  Skipped: Requires multipart form data`);

  console.log('\n' + '='.repeat(60));
  console.log('✨ Test Suite Complete!');
  console.log('='.repeat(60));

  // Test WebSocket connection
  console.log('\n🔌 Testing WebSocket Connection...');
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:4000', {
    path: '/xmtp-ws',
    headers: {
      Authorization: `Bearer ${token1}`
    }
  });

  ws.on('open', () => {
    console.log('   ✅ WebSocket connected');
    ws.close();
  });

  ws.on('error', (error) => {
    console.log('   ❌ WebSocket error:', error.message);
  });

  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 2000);
}

// Run tests
runTests().catch(console.error);