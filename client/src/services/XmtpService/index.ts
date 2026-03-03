import { Client, type Signer, IdentifierKind } from '@xmtp/node-sdk'
import { ethers } from 'ethers'
import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const prisma = new PrismaClient()

export interface XmtpIdentityData {
  userId: number
  walletAddress: string
  installationId: string
  identityKey: string
  preKeys: any
  signedPreKey: any
  registrationId: number
  encryptionKey?: string
}

export class XmtpIdentityService {
  private client: Client | null = null

  /**
   * Generate identity keys for a new XMTP user
   */
  async generateIdentity(userId: number, walletAddress: string): Promise<XmtpIdentityData> {
    // Generate installation ID
    const installationId = crypto.randomBytes(32).toString('hex')

    // Generate registration ID
    const registrationId = Math.floor(Math.random() * 2147483647)

    // Generate identity key pair
    const identityKeyPair = this.generateKeyPair()

    // Generate pre-keys for offline messaging
    const preKeys = this.generatePreKeys(10)

    // Generate signed pre-key
    const signedPreKey = this.generateSignedPreKey(identityKeyPair.privateKey)

    const identityData: XmtpIdentityData = {
      userId,
      walletAddress: walletAddress.toLowerCase(),
      installationId,
      identityKey: identityKeyPair.publicKey,
      preKeys,
      signedPreKey,
      registrationId
    }

    return identityData
  }

  /**
   * Register or update an XMTP identity for a CAW user
   */
  async registerIdentity(userId: number, walletAddress: string): Promise<XmtpIdentityData> {
    // First ensure the user exists in the database
    const user = await prisma.user.findUnique({
      where: { tokenId: userId }
    })

    if (!user) {
      // Create the user if it doesn't exist (id = tokenId)
      await prisma.user.create({
        data: {
          id: userId,
          tokenId: userId,
          address: walletAddress,
          username: `user_${userId}`
        }
      })
    }

    // Check if identity already exists
    const existingIdentity = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })

    if (existingIdentity) {
      return {
        userId: existingIdentity.userId,
        walletAddress: existingIdentity.walletAddress,
        installationId: existingIdentity.installationId,
        identityKey: existingIdentity.identityKey,
        preKeys: existingIdentity.preKeys,
        signedPreKey: existingIdentity.signedPreKey,
        registrationId: existingIdentity.registrationId,
        encryptionKey: existingIdentity.encryptionKey || undefined
      }
    }

    // Generate new identity
    const identityData = await this.generateIdentity(userId, walletAddress)

    // Generate encryption key for XMTP SDK v4
    const encryptionKey = crypto.randomBytes(32).toString('hex')

    // Store in database
    console.log("New Identity: ", identityData);
    const newIdentity = await prisma.xmtpIdentity.create({
      data: {
        ...identityData,
        encryptionKey
      }
    })

    return {
      userId: newIdentity.userId,
      walletAddress: newIdentity.walletAddress,
      installationId: newIdentity.installationId,
      identityKey: newIdentity.identityKey,
      preKeys: newIdentity.preKeys as any,
      signedPreKey: newIdentity.signedPreKey as any,
      registrationId: newIdentity.registrationId,
      encryptionKey: newIdentity.encryptionKey || undefined
    }
  }

  /**
   * Get XMTP identity for a user
   */
  async getIdentity(userId: number): Promise<XmtpIdentityData | null> {
    const identity = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })

    if (!identity) return null

    return {
      userId: identity.userId,
      walletAddress: identity.walletAddress,
      installationId: identity.installationId,
      identityKey: identity.identityKey,
      preKeys: identity.preKeys as any,
      signedPreKey: identity.signedPreKey as any,
      registrationId: identity.registrationId,
      encryptionKey: identity.encryptionKey || undefined
    }
  }

  /**
   * Get XMTP identity by wallet address
   */
  async getIdentityByWallet(walletAddress: string): Promise<XmtpIdentityData | null> {
    const identity = await prisma.xmtpIdentity.findUnique({
      where: { walletAddress: walletAddress.toLowerCase() }
    })

    if (!identity) return null

    return {
      userId: identity.userId,
      walletAddress: identity.walletAddress,
      installationId: identity.installationId,
      identityKey: identity.identityKey,
      preKeys: identity.preKeys as any,
      signedPreKey: identity.signedPreKey as any,
      registrationId: identity.registrationId,
      encryptionKey: identity.encryptionKey || undefined
    }
  }

  /**
   * Initialize XMTP client for a user
   */
  async initializeClient(userId: number): Promise<Client> {
    const identity = await this.getIdentity(userId)

    if (!identity) {
      throw new Error('XMTP identity not found for user')
    }

    // Get or generate encryption key
    let dbEncryptionKey: Uint8Array
    if (identity.encryptionKey) {
      // Convert hex string to Uint8Array
      const hexKey = identity.encryptionKey.startsWith('0x') ?
        identity.encryptionKey.slice(2) : identity.encryptionKey
      dbEncryptionKey = new Uint8Array(
        hexKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
      )
    } else {
      // Generate and save encryption key if it doesn't exist
      dbEncryptionKey = crypto.randomBytes(32)
      await prisma.xmtpIdentity.update({
        where: { userId },
        data: { encryptionKey: '0x' + Buffer.from(dbEncryptionKey).toString('hex') }
      })
    }

    // Create a deterministic wallet for each user
    // Use a combination of userId and a static seed to generate consistent wallet per user
    // TODO: In production, use the user's actual wallet or secure key management
    const walletSeed = ethers.utils.id(`xmtp-seed-${userId}-${identity.walletAddress}`)
    const wallet = new ethers.Wallet(walletSeed)

    // Create a Signer object for XMTP v4
    const signer: Signer = {
      type: "EOA" as const,
      getIdentifier: () => ({
        identifier: wallet.address.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum
      }),
      signMessage: async (message: string) => {
        // Sign the message with the wallet
        const signature = await wallet.signMessage(message)
        // Convert hex signature to Uint8Array
        const hexString = signature.startsWith('0x') ? signature.slice(2) : signature
        const bytes = new Uint8Array(
          hexString.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
        )
        return bytes
      }
    }

    // Initialize XMTP client with v4 API
    try {
      this.client = await Client.create(signer, {
        dbEncryptionKey,
        env: 'dev'
      })

      console.log(`✅ XMTP client initialized for user ${userId} with wallet ${wallet.address}`)
      return this.client
    } catch (error) {
      console.error('❌ Failed to create XMTP client:', error)
      throw error
    }
  }

  /**
   * Check if a wallet address can receive XMTP messages
   */
  async canMessage(walletAddress: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    try {
      // v4 API expects specific format for canMessage
      const results = await this.client.canMessage([{
        identifier: walletAddress.toLowerCase(),
        identifierKind: IdentifierKind.Ethereum
      }])
      return results.get(walletAddress.toLowerCase()) || false
    } catch (error) {
      console.error('Error checking canMessage:', error)
      return false
    }
  }

  /**
   * Helper function to generate key pairs
   */
  private generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })

    return { publicKey, privateKey }
  }

  /**
   * Generate pre-keys for offline messaging
   */
  private generatePreKeys(count: number) {
    const preKeys = []
    for (let i = 0; i < count; i++) {
      const keyPair = this.generateKeyPair()
      preKeys.push({
        keyId: i + 1,
        publicKey: keyPair.publicKey
      })
    }
    return preKeys
  }

  /**
   * Generate signed pre-key
   */
  private generateSignedPreKey(identityPrivateKey: string) {
    const keyPair = this.generateKeyPair()

    // Ed25519 requires special handling
    // For now, we'll use a placeholder signature since this is a mock implementation
    // In production, you'd use the actual XMTP SDK which handles this properly
    const signature = crypto
      .createHash('sha256')
      .update(keyPair.publicKey + identityPrivateKey)
      .digest('hex')

    return {
      keyId: 0,
      publicKey: keyPair.publicKey,
      signature
    }
  }
}

export default new XmtpIdentityService()
