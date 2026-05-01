# Contract-Owned Profiles

CAW profile NFTs can be owned by smart contracts. A contract that owns a profile can author actions (caws, tips, follows, etc.) by implementing [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) — `isValidSignature(bytes32 hash, bytes memory sig)`. This unlocks prediction markets, GameFi, launchpads, and any other on-chain extension that wants its own social presence on CAW.

This doc covers:

1. The interface contract owners must implement
2. Gas budget and constraints
3. A reference signature payload pattern
4. How to build extension contracts (markets, games, launchpads) on top
5. Front-end integration for custom action markers

## How verification works

When `processActions` (or `safeProcessActions`) verifies an action's signature, the flow is:

1. `ecrecover` on the submitted `(v, r, s)`. If the recovered signer equals `cawProfile.ownerOf(senderId)` — done, EOA owner authorized.
2. If not, check whether the recovered address is a session key with the right scope — done, delegated EOA authorized.
3. **If both fail and the owner is a contract** (`owner.code.length > 0`), call `owner.isValidSignature(digest, sig)` via a gas-bounded staticcall. If it returns the ERC-1271 magic value `0x1626ba7e`, the action is authorized.

EOA-owned profiles never reach step 3, so the existing hot path is unchanged.

## What `isValidSignature` receives

The `hash` argument is the **fully prefixed EIP-712 digest**:

```
digest = keccak256(0x1901 || domainSeparator || structHash)
```

This is the same bytes an EOA owner would have signed. It is *not* the bare `structHash`. If you wrap an EIP-712-aware library, pass the digest through unchanged.

The `domainSeparator` is computed from the `CawActions` contract's own domain:

```
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)
```

(See `CawActions.generateDomainHash()` for the exact values.)

The `structHash` is one of:

- **Single-action sig** — `keccak256(abi.encode(ACTIONDATA_TYPEHASH, actionType, senderId, receiverId, receiverCawonce, clientId, cawonce, keccak256(recipients), keccak256(amounts), keccak256(text)))`
- **Batch sig** — `keccak256(abi.encode(ACTIONBATCH_TYPEHASH, senderId, firstCawonce, actionCount, actionsHash))` where `actionsHash` is a keccak256 over the sequence of per-action `structHash`es.

In most cases your contract doesn't need to recompute the digest itself — it just decides whether the supplied `sig` represents a valid authorization for that digest.

## The `sig` argument

`sig` is whatever bytes ended up in the `(r, s, v)` slots of the action's signature payload. CawActions packs it back as `abi.encodePacked(r, s, v)` (65 bytes) before calling your contract.

You decide what those 65 bytes mean. Three viable patterns:

### Pattern A: Re-sign with an authorized EOA

The simplest implementation. The contract holds an `authorizedSigner` address and verifies the sig is a real ECDSA signature from that address over the digest:

```solidity
function isValidSignature(bytes32 hash, bytes memory sig)
  external view returns (bytes4)
{
  if (sig.length != 65) return 0xffffffff;
  bytes32 r; bytes32 s; uint8 v;
  assembly {
    r := mload(add(sig, 32))
    s := mload(add(sig, 64))
    v := byte(0, mload(add(sig, 96)))
  }
  address recovered = ecrecover(hash, v, r, s);
  if (recovered != address(0) && recovered == authorizedSigner) return 0x1626ba7e;
  return 0xffffffff;
}
```

This is what `solidity/contracts/mocks/MockContractOwner.sol` does. It's the right starting point for most extensions: the contract has one or more "operator" EOAs that produce sigs the same way users do today, and the contract just gatekeeps.

### Pattern B: State-lookup proof

The contract authors actions in its own state and sets a flag. `isValidSignature` checks the flag rather than recovering anything from `sig`:

```solidity
mapping(bytes32 => bool) public authorizedDigests;

function authorizeAction(bytes32 digest) internal {
  authorizedDigests[digest] = true;
}

function isValidSignature(bytes32 hash, bytes memory)
  external view returns (bytes4)
{
  return authorizedDigests[hash] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
}
```

This is cleaner when actions are produced *atomically* with whatever state change triggers them (e.g. a market resolution that needs to post a "winner: X" caw in the same tx). But each authorization costs an SSTORE, and `isValidSignature` becomes a SLOAD per call — still well under the 50k budget.

A worked example of Pattern B is `solidity/contracts/examples/CawMultisigProfile.sol` — an M-of-N multisig where each owner records an approval against the EIP-712 digest of a pending action, and `isValidSignature` returns the magic value once the threshold is reached. `sig` is unused; the proof of authorization is the storage state. The protocol's own per-senderId cawonce bitmap covers replay safety, so approved digests don't need to be cleared on consume. See `solidity/test/multisig-profile-test.js` for an end-to-end 2-of-3 walkthrough.

### Pattern C: Delegated authorization with replay protection

For contracts that accept off-chain authorizations from users (e.g. "user X said this market should resolve Y"). Sigs encode `(authorized_action_data, nonce, ecdsa_sig)`; the contract checks the ECDSA matches an authorized voter and the nonce hasn't been used. Probably overkill for most use cases — most extension contracts know exactly what they intend to post.

## Gas budget — 50,000

The `isValidSignature` staticcall gets a **50,000 gas stipend**. This is enforced in `CawActions._checkERC1271`. Reasons:

- A relaying validator could otherwise be drained by a malicious contract owner with an expensive `isValidSignature`. The cap means worst-case a bad action costs 50k gas + the fixed verification overhead, no worse than a failed ecrecover-path action.
- Out-of-gas inside the staticcall surfaces as a `false` return — same as a 1271 reject. The relaying tx isn't burned; that one action just fails verification.

50k is generous for Pattern A (~3-5k actual cost) and Pattern B (~5-8k actual cost). It's tight for anything that loops, hits multiple SLOADs, or makes external calls of its own. **Honest implementations should aim for well under the cap.** If you need more, you're probably doing something the protocol shouldn't be paying for during signature verification — move that logic into the action-authoring path instead.

## Replay protection

The protocol's existing replay protection (`cawonce` per `senderId`) applies identically to contract-authored actions. You don't need to add nonce tracking inside `isValidSignature` for replay protection of the *action* itself.

You may still want internal nonces if your authorization model uses Pattern C (delegated user sigs), since CAW only sees the contract as the actor.

## Building an extension contract — sketch

A minimal prediction market contract owning a profile would look like:

```solidity
contract SimpleMarket is IERC721Receiver {
  address public authorizedOperator;  // can call resolve() and authorize caws
  uint32 public profileId;
  mapping(uint256 => Market) public markets;

  struct Market {
    string question;
    uint256 closesAt;
    address oracle;            // designated reporter, or UMA, or whatever
    bool resolved;
    uint8 outcome;             // 0 = no, 1 = yes
    uint256 yesPool;
    uint256 noPool;
    mapping(address => uint256) yesBets;
    mapping(address => uint256) noBets;
  }

  // (1) Receive the profile NFT
  function onERC721Received(address, address, uint256 tokenId, bytes calldata)
    external override returns (bytes4)
  {
    profileId = uint32(tokenId);
    return IERC721Receiver.onERC721Received.selector;
  }

  // (2) Author an action FROM the profile this contract owns.
  //     Pattern A: operator signs, contract gatekeeps.
  function isValidSignature(bytes32 hash, bytes memory sig)
    external view returns (bytes4)
  {
    // ... ecrecover + authorizedOperator check (see Pattern A above)
  }

  // (3) Open a market by posting a caw with a ::market:: marker.
  //     The operator constructs the action, signs it, and submits via processActions.
  //     The contract authorizes via isValidSignature.

  // (4) Users bet by sending tips to this contract's profile (via normal CAW tips).
  //     A separate action-handler watches the indexer for tips to profileId
  //     with a market-bet marker and updates pools.

  // (5) Resolve via oracle, then post a resolution caw + pay out winners.
  function resolve(uint256 marketId, uint8 outcome) external {
    require(msg.sender == markets[marketId].oracle, "not oracle");
    // ... distribute pools to winners
    // ... operator queues a "market resolved" caw signed for this profile
  }
}
```

Open design questions you'll hit when building this:

- **Tips as bets vs. dedicated bet action.** Tips are the simplest UX (just send CAW to the market profile) but lose semantic structure. A dedicated `::market_bet:option_id::` marker on a tip-bearing caw is probably the right balance.
- **Oracle choice.** Designated reporter (1-of-1 trust) is fastest to ship. UMA's optimistic oracle gives you crypto-native dispute resolution. Chainlink data feeds work for pre-defined data sources. Mix as appropriate.
- **Withdrawal of contract-held CAW.** A contract holding a profile can withdraw the profile's CAW balance through the standard `WITHDRAW` action — same path as users — since `isValidSignature` lets it author one.
- **clientId.** Pick a real `clientId` for the operator's frontend (so the action is anchored to a checkpoint correctly) or coordinate with the validator team about a reserved `clientId` for contract-direct flows.

## Front-end integration — sketch

Custom action markers (like `::poll::` or `::market::`) follow the same pattern as the existing inline-poll renderer. To support a new marker:

1. **Define the marker grammar** in the post text — e.g. `::market:question:closesAt:option1:option2::`. Pick a delimiter your existing post tokenizer can handle (the polls feature uses `::poll:opt1:opt2:::`).
2. **Update the post parser/renderer** in `client/src/services/FrontEnd/` — locate the polls renderer (look for `::poll::` parsing) and follow the same shape: detect the marker, extract its payload, render a custom React component above/inline with the post text.
3. **Wire the component to live data.** For markets this means querying the market contract for current pools, user positions, resolution state, etc. Use Wagmi reads keyed off the `marketId` extracted from the marker.
4. **Authoring UI.** A "Post a market" composer that produces the marker and submits a normal action — no special protocol path needed. Users pay the protocol's normal storage fee in CAW.
5. **Bet UI.** Probably a dedicated tip-with-marker affordance. The bet itself is a tip to the market's profile with a `::market_bet:option_id::` marker; the indexer picks this up and the contract's off-chain watcher updates pools. (Or do the bet on chain directly with a custom contract method — depends on whether you want bets to be CAW actions in the indexed feed or just on-chain events.)

The polling implementation in `dd2d399 feat(polls): inline polls on caws via ::poll:opt1:opt2:::: marker` is the reference. Look at that commit for the parser, renderer, and composer wiring.

## Tests

See `solidity/test/erc1271-actions-test.js` for end-to-end coverage:

- Single-action 1271 happy path
- Batch 1271 happy path
- 1271 rejection (returns `0xffffffff`)
- EOA regressions (single-sig and session-key paths still work unchanged)

`solidity/contracts/mocks/MockContractOwner.sol` is a minimal Pattern-A reference implementation suitable for copying into tests of new extension contracts.
