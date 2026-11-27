import { AbiCoder, Contract, ZeroAddress, dataSlice, id, isError } from 'ethers'

const legacySelector = dataSlice(id('lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])'), 0, 4)
const generationSelector = dataSlice(id('lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint128[])'), 0, 4)

export async function ownershipBundleSelector(profile: Contract): Promise<string> {
  try {
    const selector = await profile.ownershipBundleSelector()
    if (selector !== generationSelector) throw new Error('Unsupported profile ownership bundle version')
    return selector
  } catch (error) {
    // The fixed Base fallback succeeds with zero bytes. ethers reports the
    // decode failure separately from an empty revert on an unknown selector.
    const emptyResult = isError(error, 'BAD_DATA') && error.value === '0x' &&
      error.info?.signature === 'ownershipBundleSelector()'
    const emptyRevert = isError(error, 'CALL_EXCEPTION') && error.data === '0x'
    if (!emptyResult && !emptyRevert) throw error

    // An EOA or an unrelated empty fallback can produce the same result.
    // Check the configured profile's ERC-721 metadata before using the old ABI.
    if (await profile.name() !== 'CAW NAME' || await profile.symbol() !== 'cawNAME') {
      throw new Error('Unrecognized legacy ownership profile')
    }
    return legacySelector
  }
}

// Quote the same owner-update count as mintAndDeposit. newId is unknown but fixed-width.
export async function quoteMintOwnershipBundle(profile: Contract, networkId: number, dest: number,
  recipient: string, username: string, depositAmount: bigint): Promise<bigint> {
  const selector = await ownershipBundleSelector(profile)
  const [ids, owners, stamps] = await profile.pendingTransferUpdates(dest, recipient, 0)
  const payload = AbiCoder.defaultAbiCoder().encode(
    ['uint32','uint32','uint256','string','address','uint64','uint256','uint64','uint32[]','address[]','uint128[]'],
    [networkId, 0, depositAmount, username, ZeroAddress, 0, 0, 0, ids, owners, stamps],
  )
  const quote = await profile.lzQuote(networkId, selector, ids.length, selector + payload.slice(2), dest, false)
  return quote.nativeFee ?? quote[0]
}
