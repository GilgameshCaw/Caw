import { Client } from '@xmtp/node-sdk'
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
        registrationId: existingIdentity.registrationId
      }
    }

    // Generate new identity
    const identityData = await this.generateIdentity(userId, walletAddress)

    // Store in database
    const newIdentity = await prisma.xmtpIdentity.create({
      data: identityData
    })

    return {
      userId: newIdentity.userId,
      walletAddress: newIdentity.walletAddress,
      installationId: newIdentity.installationId,
      identityKey: newIdentity.identityKey,
      preKeys: newIdentity.preKeys as any,
      signedPreKey: newIdentity.signedPreKey as any,
      registrationId: newIdentity.registrationId
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
      registrationId: identity.registrationId
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
      registrationId: identity.registrationId
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

    // Create a wallet from the validator private key (for dev)
    const wallet = new ethers.Wallet(process.env.VALIDATOR_PRIVATE_KEY!)

    // Initialize XMTP client with the wallet
    this.client = await Client.create(wallet, {
      env: 'dev' as any
    })

    return this.client
  }

  /**
   * Check if a wallet address can receive XMTP messages
   */
  async canMessage(walletAddress: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('XMTP client not initialized')
    }

    return await this.client.canMessage(walletAddress)
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
    const signature = crypto
      .createSign('SHA256')
      .update(keyPair.publicKey)
      .sign(identityPrivateKey, 'hex')

    return {
      keyId: 0,
      publicKey: keyPair.publicKey,
      signature
    }
  }
}

export default new XmtpIdentityService()