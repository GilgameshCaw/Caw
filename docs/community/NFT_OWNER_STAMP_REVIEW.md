# NFT ownership updates sharing a block stamp

Review baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. This extends NFT-01; it is a source-backed candidate requiring an actual-contract regression, not a demonstrated live-chain exploit or a new accepted policy.

## FACT: source paths

- [CawProfile._afterTokenTransfer](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L875) sends `uint64(block.number)` to `setOwnerOf` for a chosen local/mainnet ledger. Remote destinations queue transfers instead.
- [CawProfileLedger._setOwnerOf](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileLedger.sol#L681) returns when `stamp <= lastOwnerUpdateBlock[tokenId]`, before changing the ledger owner or invalidating sessions.
- [Token-scoped session registration](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileLedger.sol#L838) checks the recovered signer against that local owner mirror.
- The source already documents a separate asynchronous cross-chain transfer window at CawProfile.sol:780. That admission does not prove this same-block local case was tested or agreed.

## INFERENCE and bounded model

For a token already subscribed to the local ledger, consider successful A-to-B then B-to-C NFT transfers in block N. The first ledger update can accept N; the second receives N again and returns. The source paths therefore suggest the NFT owner could become C while the ledger still names B. This also suggests the second transfer would not invalidate B's sessions through this update path. Transaction success, downstream spend feasibility, and any additional protection must be checked in the deployed contract configuration.

A small Python predicate model reproduced B remaining after stamps [100,100], with C reached by the [100,101] control. This checks the arithmetic consequence only. It is not an EVM test, not two mined transactions, and not proof of financial loss. No timing estimate or deployed-chain claim is made.

## Requirement and next evidence

The [official manifesto](https://github.com/cawdevelopment/manifesto/blob/main/README.md) assigns account and balance access to the NFT owner and describes the NFT as the wallet key. An implementation that leaves account authority with a previous owner would conflict with that ownership rule. The [recovered R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) calls for peer review and clear agreement on changes; recovered bytes do not establish author identity.

Before proposing a behavioral patch, reproduce both transfers using the real contracts and a chosen local ledger; assert final ERC-721 owner, mirrored owner, epochs, and previous/current owner authorization. Include mint/authenticate-plus-transfer in one block, different-block transfers, duplicate remote delivery, stale delivery, and reordered messages. Do not replace `<=` with `<` globally: that can reopen equal-stamp remote replay/reordering behavior. A fix must distinguish ordered local updates from remote freshness, or introduce a proven ordering scheme without a privileged administrator.

## Non-duplication and limits

The current PR title/body census was searched for same-block/stamp and owner-update identifiers. No dedicated matching ownership fix was identified in that bounded search; it does not prove absence from every diff or review comment. This record strengthens existing NFT-01 in #424, rather than opening another patch without the required contract reproduction. Existing unrelated same-block indexer fixes are not ownership fixes.

Status: source-observed comparison; high-impact candidate if reachable; actual-contract regression and safe fix unresolved. No launch acceptance, community agreement, or intent inference.
