# Sponsored funding consent — existing PR #306

Baseline `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`. This is an asset-authorization finding with an existing draft proposal. It is separate from the sponsor exemption/finalization policy and from the sponsored-profile withdrawal gate.

## FACT — whose permission is checked, whose CAW is taken

[`mintAndDepositSponsored`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMinter.sol#L619) validates the recipient's permit and then selects the funder as `msg.sender` for a caller without code, or `tx.origin` for a caller with code. The selected address pays the mint burn and any deposit through the token allowance mechanism.

[`depositForSponsored`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawProfileMinter.sol#L718) similarly validates the NFT owner's permit, then uses the same funder-selection rule before `CAW.transferFrom`. The checked permit is the beneficiary/owner's authorization, not necessarily the selected funder's authorization.

The later `isAuthorizedSponsor` lookup controls a fee exemption; a false result does not itself reject the funding operation. That lookup therefore must not be described as a mandatory sponsor allowlist protecting this path.

## INFERENCE — missing consent boundary

An origin address with sufficient CAW and an existing minter allowance can be selected as payer when it calls an intermediary contract, even though the valid recipient/owner permit belongs to somebody else. The code does not separately require that origin to opt into this contract-mediated sponsorship. A recipient's permit cannot establish the payer's consent. Broadcasting a transaction to an intermediary is not in itself proof of understanding and accepting every downstream sponsored spend.

This does not bypass ERC-20 allowances, recover a private key, or debit an arbitrary uninvolved wallet. It requires the origin to initiate the transaction, sufficient balance and allowance, a valid beneficiary permit and the other call prerequisites. No live theft, exploit transaction or universal wallet exposure is asserted here.

## Existing proposal and test boundaries

[PR #306](https://github.com/GilgameshCaw/Caw/pull/306), head `b564bc7ab06465e4fd7a2a9f4a40bf2f9d2f0697`, state open, draft=true, proposes explicit origin-funder opt-in and corresponding deployment/sponsor-service handling. Its source was checked for the opt-in mapping and rejection path. It does not appoint a central administrator to approve payers.

The author reports local tests covering opt-in, opt-out and direct callers, with stated skipped/failing cases and no full-suite run. Those results have not been independently rerun in this review. A persistent opt-in is not equivalent to a per-operation payer signature: assess whether its scope and revocation semantics are sufficiently clear for the intended sponsors. Do not silently treat the proposed design as an accepted specification decision or complete protection for every opted-in payer.

## Manifesto / R2 relevance and next action

The [manifesto](https://github.com/cawdevelopment/manifesto/blob/main/README.md) gives the NFT owner control of the associated account and balance, while the [reproduced R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) requires a solid, peer-reviewed release. This funding path additionally touches the payer's external wallet allowance. The connection to those principles is an asset-control/security inference, not a literal manifesto clause specifying `tx.origin` or a required opt-in API. Recovery of R2 bytes does not establish their author.

Use existing #306 rather than opening a duplicate. Review payer consent independently from recipient consent; reproduce unauthorized contract-mediated funding rejection, intentional sponsorship, revocation, direct calls and delegated-account cases. Preserve allowance prerequisites and failed controls in the report. A contract redeployment and its immutable profile/minter dependencies need explicit migration review. No new administrator key is needed to express a payer's own authorization.

Status: source-corroborated authorization gap; existing draft remedy; external tests attributed, independent rerun and policy choice pending. Not a blanket verdict on every sponsored account or deployment.
