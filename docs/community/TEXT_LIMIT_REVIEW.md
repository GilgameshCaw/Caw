# What does the 420 limit count?

the manifesto's proposal a specifies a maximum character limit of 420. this review identifies a narrower, source-observed discrepancy than a general Unicode counting question: the contract counts compressed payload bytes.

## Pinned source

Baseline: `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`.

- [CawActions.ActionData](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L94) declares `bytes text`, documented as smltxt-compressed UTF-8.
- [_applyAction](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/solidity/contracts/CawActions.sol#L1300) rejects `action.text.length > 420`. It does not decompress that value to count characters at this check.
- The [repository's codec](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/smltxt/dist/src/SmlTxt.js) can encode more than 420 ASCII characters in fewer than 420 bytes.

## Finite reproduction

The actual bundled codec produced these round-tripping inputs, each consisting only of repeated lowercase ASCII `a`:

| Decoded characters / UTF-8 bytes | Compressed bytes | Passes this length predicate |
|---|---|---|
| 420 | 160 | yes |
| 421 | 160 | yes |
| 600 | 227 | yes |

This does not depend on a choice between Unicode code points and grapheme clusters: for these ASCII inputs the counts agree. It establishes that the compressed-byte ceiling alone does not implement the stated character ceiling. It does **not** establish that a full signed action, API request, validator submission or deployed transaction accepts these examples. Other authorization, encoding and state checks remain separate.

Reproduce from the review branch with Node (recorded runtime: 24.20.0):

```sh
node --max-old-space-size=256 scripts/review-text-limit.cjs
```

No dependency installation is required; this uses the committed CommonJS codec. The script verifies the [source hashes](TEXT_LIMIT_SOURCES.json), checks the exact contract predicate is still present, round-trips all three inputs, and requires an over-420-character input to pass that predicate. [Recorded output](TEXT_LIMIT_RESULT.json) includes the compressed bytes. This is a codec/source-predicate reproduction, not an EVM test. The initial local 128 MiB heap attempt exhausted its heap during codec initialization; the preserved second run used 256 MiB with the existing 512 MiB process guard unchanged.

## Decision needed before calling the limit aligned

The [official manifesto](https://github.com/cawdevelopment/manifesto/blob/37399aeb55974d4b09d404014865b5ef8918e9de/README.md) specifies characters. The [reproduced R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) allows clear agreed changes. Its byte recovery does not authenticate the author.

Please identify whether the agreed rule is 420 decoded characters, 420 compressed bytes, or another explicitly defined measure, and where protocol-level enforcement belongs. A frontend limit alone would not establish the same invariant for independent callers. A compressed-byte ceiling may serve resource control, but should not be described as equivalent without agreement.

Do not introduce a new trusted validator/admin as the convenient enforcement mechanism. Do not remove compression or alter signed-action encoding without cost, compatibility and historical-replay analysis. This PR records the discrepancy and asks for the rule; it does not silently choose one or claim a complete exploit.
