import { Contract, dataSlice, id, isError } from 'ethers'

const legacySelector = dataSlice(id('lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])'), 0, 4)
const generationSelector = dataSlice(id('lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint128[])'), 0, 4)

export async function ownershipBundleSelector(profile: Contract): Promise<string> {
  try {
    const selector = await profile.ownershipBundleSelector()
    if (selector !== generationSelector) throw new Error('Unsupported profile ownership bundle version')
    return selector
  } catch (error) {
    // The original immutable profile reverts with empty data for an unknown selector.
    if (isError(error, 'CALL_EXCEPTION') && error.data === '0x') return legacySelector
    throw error
  }
}
