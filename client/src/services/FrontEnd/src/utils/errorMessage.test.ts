import { describe, it, expect } from 'vitest'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
} from 'viem'
import { formatWalletError } from './errorMessage'

// Real viem errors, as wagmi's writeContract / simulateContract throw them.
const abi = [
  { type: 'function', name: 'cancelOffer', stateMutability: 'nonpayable', inputs: [{ name: 'offerId', type: 'uint256' }], outputs: [] },
] as const
const errorAbi = [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }] as const
const CONTRACT = '0x858F60fC71bAfBdC6Ba170aCC7dc8974F6270CBD'
const SENDER = '0x43241ea5000000000000000000000000000000aa'

function revertWithReason(reason: string, sender: string = SENDER) {
  const data = encodeErrorResult({ abi: errorAbi, errorName: 'Error', args: [reason] })
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: 'cancelOffer' })
  return new ContractFunctionExecutionError(cause, {
    abi, args: [2n], contractAddress: CONTRACT, functionName: 'cancelOffer', sender: sender as `0x${string}`,
  })
}
function revertWithData(data: `0x${string}` | undefined) {
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: 'cancelOffer' })
  return new ContractFunctionExecutionError(cause, {
    abi, args: [2n], contractAddress: CONTRACT, functionName: 'cancelOffer', sender: SENDER,
  })
}

describe('formatWalletError', () => {
  describe('contract reverts (viem)', () => {
    it('shows the revert reason, not the first line of the message', () => {
      expect(formatWalletError(revertWithReason('Offer not active'))).toBe('Offer not active')
      expect(formatWalletError(revertWithReason('Token already listed'))).toBe('Token already listed')
    })

    it('shows the reason when an address in the message contains "429"', () => {
      const sender = '0x1234567890429abcdef1234567890abcdef12345'
      expect(revertWithReason('Offer not active', sender).message).toContain('429')
      expect(formatWalletError(revertWithReason('Offer not active', sender))).toBe('Offer not active')
    })

    it('shows a reason that itself contains a number like 429 or a word like timeout', () => {
      expect(formatWalletError(revertWithReason('Cannot exceed 429 limit'))).toBe('Cannot exceed 429 limit')
      expect(formatWalletError(revertWithReason('Auction timeout reached'))).toBe('Auction timeout reached')
    })

    it('falls back to the generic text for a custom error the ABI cannot decode', () => {
      expect(formatWalletError(revertWithData('0xdeadbeef')))
        .toBe('The transaction was rejected by the network. Please try again.')
    })

    it('leaves a revert without a reason as it was: "The contract function ... reverted."', () => {
      expect(formatWalletError(revertWithData(undefined))).toBe('The contract function "cancelOffer" reverted.')
    })

    it('does not show a reason that is too long to be a friendly sentence', () => {
      expect(formatWalletError(revertWithReason('x'.repeat(200)))).not.toContain('xxxxxxxxxx')
    })
  })

  describe('network errors', () => {
    it('treats a real 429 as a temporary network issue', () => {
      const net = 'A temporary network issue interrupted this. Please try again.'
      expect(formatWalletError(new Error('HTTP request failed. Status: 429 Too Many Requests'))).toBe(net)
      expect(formatWalletError(new Error('server returned 429'))).toBe(net)
      expect(formatWalletError(new Error('request timeout'))).toBe(net)
      expect(formatWalletError(new Error('provider destroyed; cancelled request'))).toBe(net)
    })

    it('does not take an address or hash containing "429" for a network issue', () => {
      const msg = 'Transaction failed for 0x1234567890429abcdef1234567890abcdef12345'
      expect(formatWalletError(new Error(msg))).toBe(msg)
    })
  })

  describe('everything else as before', () => {
    it('normalizes a user rejection', () => {
      expect(formatWalletError(new Error('User rejected the request. Details: x Version: viem@2.31.3'))).toBe('User rejected the request')
      expect(formatWalletError(new Error('user denied transaction signature'))).toBe('User rejected the request')
    })

    it('hides ethers revert noise', () => {
      const rejected = 'The transaction was rejected by the network. Please try again.'
      expect(formatWalletError(new Error('execution reverted'))).toBe(rejected)
      expect(formatWalletError(new Error('call revert exception [ CALL_EXCEPTION ]'))).toBe(rejected)
    })

    it('strips the viem Details / Version trailers from the first line', () => {
      expect(formatWalletError(new Error('Something specific happened. Details: more\nVersion: viem@2.31.3'))).toBe('Something specific happened.')
    })

    it('falls back for raw ethers noise and over-long messages', () => {
      expect(formatWalletError(new Error('bad thing (code=INVALID_ARGUMENT, version=6.1)'))).toBe('Something went wrong. Please try again.')
      expect(formatWalletError(new Error('y'.repeat(200)))).toBe('Something went wrong. Please try again.')
    })

    it('handles an empty or non-Error value', () => {
      expect(formatWalletError(undefined)).toBe('Something went wrong')
      expect(formatWalletError(null)).toBe('Something went wrong')
      expect(formatWalletError('plain string')).toBe('plain string')
    })
  })
})
