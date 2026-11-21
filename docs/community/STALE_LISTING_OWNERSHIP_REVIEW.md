# Stale marketplace listings and NFT-owner control

Baseline `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. This strengthens NFT-01 using an existing contributor's finding and proposed fix. Do not open a duplicate PR.

## FACT — source-observed ownership mismatch

At master, [buy and buyWithToken](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMarketplace.sol#L235) pay or credit `listing.seller` and call `CawProfile.transferAndSync`. [settleAuction](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMarketplace.sol#L380) does the same. These paths do not check that the listing seller remains the NFT owner.

[transferAndSync](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfile.sol#L792) obtains the current `ownerOf(tokenId)` and checks that owner's approval of the caller (the marketplace), then transfers from that current owner. It does not receive the expected listing seller.

Consequently, the two contract paths bind the payment recipient and NFT source to different authorities. If A lists, transfers to B without closing the listing, and B has approved the marketplace, a later sale can transfer B's token while paying A. Without B's marketplace approval this particular path reverts; it is not a universal ability to seize arbitrary NFTs. B's general approval does not establish that B created or accepted A's old listing terms.

[reclaimListing / reclaimBid](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMarketplace.sol#L418) can clear stale listings, but depend on a separate call. They are not an ownership check at settlement. `acceptOffer` explicitly checks the accepting caller is the current owner and is not the same stale-listing finding.

## Existing fix and evidence attribution

[PR #351](https://github.com/GilgameshCaw/Caw/pull/351), current head `f93957bd47c3d96b9af030e4b6412a68ece97c60`, is open and draft=true. Its second commit passes the expected seller to a helper and calls `transferFrom(expectedOwner, ...)`, making an ownership mismatch revert. The PR credits Zinsanjp for raising the stale-listing problem. It also fixes a separate marketplace refund-to-relayer problem; those concerns must not be conflated.

The author reports four real-CawProfile Foundry stale-listing tests: three stale-sale cases fail on master and pass on the proposed fix, with a seller-reacquires-token control passing. The checked-in test source and proposed transfer code were read in this review. **Those test results are author-reported, not independently rerun here.** The PR also reports full-suite failures and unrun Truffle tests; it is not a clean full-suite or deployment certification. Mock transport and local contract tests are not a live-chain reproduction.

## Manifesto and release consequence

The [manifesto](https://github.com/cawdevelopment/manifesto/blob/main/README.md) makes the NFT the ownership key for the associated account and assets. A stale seller's terms remaining executable against an approved new owner's NFT is a concrete ownership-safety discrepancy, not merely a different interface preference. The optional marketplace can be replaced, but this implementation should not be represented as a safe realization of that ownership promise while the defect remains.

The [reproduced R2 message](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) calls for peer review and an agreed release. A source comment, generic marketplace approval, or open PR is not community agreement to this defect. Recovery of that text does not authenticate its author.

## Action and boundaries

Review and independently reproduce #351 instead of duplicating it. Preserve its negative controls, check integration with the sale-quote fixes, and explicitly plan old marketplace listings/escrow handling: a replacement contract does not patch an immutable old deployment. No claim is made that a live theft occurred, that this is an administrator backdoor, or that the entire PR is ready to merge. This record is source corroboration plus attributed external test evidence.


## Independent reviewer record

[tentencaw's review](https://github.com/GilgameshCaw/Caw/pull/351#issuecomment-6384579042) independently reports 4/4 stale-listing tests on `f93957bd`, versus one control passing and three failures on master. Additional approved/unapproved-owner and auction-refund cases distinguish the approval prerequisite and confirm that reclaiming works after the fixed settlement rejects. The review reports the same 11 full-suite failures on both compared trees; it does not claim a fully green suite or deployed-chain certification. These are independently reported reviewer results, not a rerun by this review's author. Preserve both reviewer and original-author attribution.
