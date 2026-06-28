// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// SessionProfileScoping.t.sol
// =============================================================================
//
// Proves that CawActions' session-key profile-scoping guard is sound:
//
//   WALLET-SCOPED (profileId == 0): one session key may sign for ANY profile
//     owned by the same wallet.
//
//   TOKEN-SCOPED (profileId != 0): session key may ONLY sign for the bound
//     tokenId; any other senderId reverts WrongProfileForSession.
//
// Two tests, two assertions each:
//   test_walletScoped_signsAnyOwnedProfile
//     A: processActions with senderId=A  → success
//     B: processActions with senderId=B  → success  (same session key, same owner)
//
//   test_tokenScoped_rejectsOtherProfile
//     C: processActions with senderId=A (= bound profileId) → success
//     D: processActions with senderId=B (≠ bound profileId) → WrongProfileForSession
//
// Setup strategy
// ─────────────
// • Deploy CawProfileLedger (bypassLZ=true, test contract as _cawProfile)
//   so that the test can call onlyOnMainnet helpers (auth, mint, setOwnerOf).
// • Deploy CawActions pointing at the Ledger.
// • Pre-wire ownerOf + authenticated for two tokenIds via vm.store (avoids
//   needing a full CawProfile + CAW-token stack).
// • Register sessions via the public EIP-712 entry point (registerSession
//   for wallet-scoped, registerTokenScopedSession for token-scoped).
// • Actions: UNFOLLOW (ActionType 5) — zero protocol cost, no balance needed.
// • Pack calldata by hand following the layout in CawActions.sol:293.
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawActions.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract SessionProfileScopingTest is Test {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint32 constant NETWORK_ID   = 1;
    uint32 constant TOKEN_A      = 10;
    uint32 constant TOKEN_B      = 20;
    uint32 constant VALIDATOR_ID = 99;

    // Owner private key and address.
    uint256 constant OWNER_PK    = 0xA11CE1;
    // Session key private keys and addresses.
    uint256 constant SESSION_PK  = 0x5E55101;
    uint256 constant SESSION_PK2 = 0x5E55102; // token-scoped session

    // EIP-712 type hashes (mirrors CawProfileLedger constants)
    bytes32 constant DELEGATION_TYPEHASH = keccak256(
        "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
    );
    bytes32 constant TOKEN_DELEGATION_TYPEHASH = keccak256(
        "TokenSessionDelegation(uint32 profileId,address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
    );

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    MockLayerZeroEndpoint lzEndpoint;
    CawProfileLedger      ledger;
    CawActions            actions;

    address owner;
    address sessionKey;
    address sessionKey2;

    // -----------------------------------------------------------------------
    // setUp
    // -----------------------------------------------------------------------

    function setUp() public {
        owner      = vm.addr(OWNER_PK);
        sessionKey  = vm.addr(SESSION_PK);
        sessionKey2 = vm.addr(SESSION_PK2);

        // Deploy LZ mock (EID arbitrary — no real messages sent).
        lzEndpoint = new MockLayerZeroEndpoint(40245);

        // Predict deployment addresses so we can wire them at construction.
        //   nonce(this)+0 = lzEndpoint (already deployed above)
        //   nonce(this)+0 = ledger (next)
        //   nonce(this)+1 = actions (after that)
        address predictedLedger  = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedActions = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        // Deploy CawProfileLedger.
        //   _cawProfile   = address(this)   → test contract can call onlyOnMainnet helpers
        //   _cawActions   = predictedActions → CawActions will be live at that address
        //   _erc1271Sibling = address(0xbeef) → non-zero dummy (unused in these tests)
        //   bypassLZ = true
        ledger = new CawProfileLedger(
            30101,                  // _endpointId (L1 EID)
            address(lzEndpoint),    // _endpoint
            address(0),             // _capOracle (dormant)
            address(this),          // _cawProfile  ← test contract acts as L1 CawProfile
            predictedActions,       // _cawActions
            address(0xbeef),        // _erc1271Sibling (dummy non-zero)
            true,                   // _bypassLZ
            address(this)           // _pathwayExpander (becomes OApp owner)
        );
        require(address(ledger) == predictedLedger, "ledger addr mismatch");

        // Deploy CawActions.
        //   _cawProfiles = ledger
        //   zkVerifier   = address(0) → ZK path disabled (we use processActions sig path)
        //   erc1271Sibling = address(0) → unused
        //   capOracle    = address(0) → dormant cap
        actions = new CawActions(
            address(ledger),
            address(0),    // _zkVerifier
            bytes32(0),    // _zkProgramVKey
            address(0),    // _erc1271Sibling (unused)
            address(0),    // _capOracle
            0,             // _bootstrapRatio
            0              // _bootstrapExpiry
        );
        require(address(actions) == predictedActions, "actions addr mismatch");

        // Wire token ownership and authentication directly via bypassLZ helpers.
        // The test contract IS _cawProfile, so onlyOnMainnet passes.
        //
        // mint() calls _setOwnerOf internally but onlyOnMainnet reverts unless
        // msg.sender == cawProfile (= address(this)), which is satisfied here.
        ledger.mint(TOKEN_A, owner, "tokenA", uint64(block.number));
        ledger.mint(TOKEN_B, owner, "tokenB", uint64(block.number));

        // Authenticate both tokens against NETWORK_ID so processActions doesn't
        // revert with UserNotAuth.
        ledger.auth(NETWORK_ID, TOKEN_A, address(0));
        ledger.auth(NETWORK_ID, TOKEN_B, address(0));

        // Also mint and authenticate the validator token so the implicit-tip
        // flush in processActions can call addTokensToBalance(VALIDATOR_ID, ...)
        // without reverting on UnknownOwner.  VALIDATOR_ID=99, owned by address(this).
        ledger.mint(VALIDATOR_ID, address(this), "validator", uint64(block.number));
        ledger.auth(NETWORK_ID, VALIDATOR_ID, address(0));
    }

    // -----------------------------------------------------------------------
    // EIP-712 helpers
    // -----------------------------------------------------------------------

    /// @dev Build and sign a wallet-scoped session delegation digest.
    function _registerWalletSession(
        address _sessionKey,
        uint256 ownerPk,
        uint64 expiry,
        uint8 scope,
        uint256 spendLimit,
        uint64 tipRate
    ) internal {
        address signer = vm.addr(ownerPk);
        uint256 nonce = ledger.sessionNonce(signer);
        bytes32 domain = ledger.eip712DomainHash();

        bytes32 structHash = keccak256(abi.encode(
            DELEGATION_TYPEHASH,
            _sessionKey,
            expiry,
            scope,
            spendLimit,
            tipRate,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        ledger.registerSession(
            signer,
            _sessionKey,
            expiry,
            scope,
            spendLimit,
            tipRate,
            nonce,
            abi.encodePacked(r, s, v)
        );
    }

    /// @dev Build and sign a token-scoped session delegation digest.
    function _registerTokenSession(
        uint32 profileId,
        address _sessionKey,
        uint256 ownerPk,
        uint64 expiry,
        uint8 scope,
        uint256 spendLimit,
        uint64 tipRate
    ) internal {
        uint256 nonce = ledger.tokenSessionNonce(profileId);
        bytes32 domain = ledger.eip712DomainHash();

        bytes32 structHash = keccak256(abi.encode(
            TOKEN_DELEGATION_TYPEHASH,
            profileId,
            _sessionKey,
            expiry,
            scope,
            spendLimit,
            tipRate,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        ledger.registerTokenScopedSession(
            profileId,
            _sessionKey,
            expiry,
            scope,
            spendLimit,
            tipRate,
            nonce,
            v, r, s
        );
    }

    // -----------------------------------------------------------------------
    // Packed-calldata helpers
    // -----------------------------------------------------------------------

    // ActionType enum mirrors CawActions.sol:83
    // UNFOLLOW = 5 (no cost, no balance required)
    uint8 constant ACTION_UNFOLLOW = 5;

    /// @dev Pack a single UNFOLLOW action.
    ///   packedActions layout:
    ///     [2] uint16 actionCount = 1
    ///     [1] uint8  actionType
    ///     [4] uint32 senderId
    ///     [4] uint32 receiverId     (must != senderId for FOLLOW; UNFOLLOW permits same)
    ///     [4] uint32 receiverCawonce
    ///     [4] uint32 networkId
    ///     [4] uint32 cawonce
    ///     [1] uint8  recipientCount = 0
    ///     [1] uint8  amountCount    = 0
    ///     [2] uint16 textLength     = 0
    ///   Total: 27 bytes.
    function _packUnfollow(
        uint32 senderId,
        uint32 receiverId,
        uint32 networkId,
        uint32 cawonce
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint16(1),          // actionCount
            ACTION_UNFOLLOW,    // actionType (uint8)
            senderId,           // uint32
            receiverId,         // uint32
            uint32(0),          // receiverCawonce
            networkId,          // uint32
            cawonce,            // uint32
            uint8(0),           // recipientCount
            uint8(0),           // amountCount
            uint16(0)           // textLength
        );
    }

    /// @dev Build the EIP-712 digest for an UNFOLLOW action so we can sign it
    ///      with either the owner key or a session key.
    function _actionDigest(
        uint32 senderId,
        uint32 receiverId,
        uint32 networkId,
        uint32 cawonce
    ) internal view returns (bytes32) {
        bytes32 ACTIONDATA_TYPEHASH = keccak256(
            "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
        );
        // Empty arrays / empty bytes
        bytes32 recipHash = keccak256(abi.encodePacked(new uint32[](0)));
        bytes32 amtHash   = keccak256(abi.encodePacked(new uint64[](0)));
        bytes32 textHash  = keccak256(new bytes(0));

        bytes32 structHash = keccak256(abi.encode(
            ACTIONDATA_TYPEHASH,
            uint256(ACTION_UNFOLLOW),  // actionType
            uint256(senderId),
            uint256(receiverId),
            uint256(0),                // receiverCawonce
            uint256(networkId),
            uint256(cawonce),
            recipHash,
            amtHash,
            textHash
        ));
        return keccak256(abi.encodePacked("\x19\x01", actions.eip712DomainHash(), structHash));
    }

    /// @dev Pack a single-sig group header: groupSize=1, then v, r, s.
    ///   sigs layout:
    ///     [2] uint16 numGroups = 1
    ///     [2] uint16 groupSize = 1
    ///     [1] uint8  v
    ///     [32] bytes32 r
    ///     [32] bytes32 s
    function _packSingleSig(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint16(1),  // numGroups
            uint16(1),  // groupSize
            v,
            r,
            s
        );
    }

    /// @dev Sign an action digest with the given private key and return packed (v, r, s).
    function _signAction(
        uint256 pk,
        uint32 senderId,
        uint32 receiverId,
        uint32 networkId,
        uint32 cawonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = _actionDigest(senderId, receiverId, networkId, cawonce);
        (v, r, s) = vm.sign(pk, digest);
    }

    // -----------------------------------------------------------------------
    // Test 1: wallet-scoped session signs for ANY owned profile
    // -----------------------------------------------------------------------

    /// @notice A profileId==0 (wallet-scoped) session key registered for `owner`
    ///         (who owns TOKEN_A and TOKEN_B) must be accepted for actions from
    ///         EITHER token. This proves the txqueue-280 case is intended behavior.
    function test_walletScoped_signsAnyOwnedProfile() public {
        // Register a wallet-scoped (profileId==0) session.
        uint64 expiry    = uint64(block.timestamp + 7 days);
        uint8  scope     = 0xBF; // all bits except WITHDRAW (bit 6)
        uint256 spend    = 1_000_000 ether;
        uint64 tipRate   = 0;
        _registerWalletSession(sessionKey, OWNER_PK, expiry, scope, spend, tipRate);

        // Verify the session was stored as wallet-scoped (profileId == 0).
        // sessions() is a public mapping that returns the tuple members individually.
        (, , , , uint32 storedProfileId, ) = ledger.sessions(owner, sessionKey);
        assertEq(storedProfileId, 0, "wallet-scoped: profileId must be 0");

        // ---- Part A: sign for TOKEN_A ----
        {
            uint32 cawonce = 1;
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK, TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            // Must not revert.
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }

        // ---- Part B: same session key, sign for TOKEN_B ----
        {
            uint32 cawonce = 1; // fresh slot for TOKEN_B
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK, TOKEN_B, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_B, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            // Must not revert — wallet-scoped key covers all owner's profiles.
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }

        // If we reach here both processActions calls succeeded — wallet-scoped session
        // correctly authorizes actions for both TOKEN_A and TOKEN_B.
    }

    // -----------------------------------------------------------------------
    // Test 2: token-scoped session rejects the wrong profile
    // -----------------------------------------------------------------------

    /// @notice A token-scoped session (profileId==TOKEN_A) must:
    ///   C: SUCCEED  when senderId == TOKEN_A   (positive control)
    ///   D: REVERT WrongProfileForSession when senderId == TOKEN_B
    function test_tokenScoped_rejectsOtherProfile() public {
        // Register a token-scoped session bound to TOKEN_A.
        uint64 expiry  = uint64(block.timestamp + 7 days);
        uint8  scope   = 0xBF;
        uint256 spend  = 1_000_000 ether;
        uint64 tipRate = 0;
        _registerTokenSession(TOKEN_A, sessionKey2, OWNER_PK, expiry, scope, spend, tipRate);

        // Verify stored session has profileId == TOKEN_A.
        (, , , , uint32 storedProfileId2, ) = ledger.sessions(owner, sessionKey2);
        assertEq(storedProfileId2, TOKEN_A, "token-scoped: profileId must be TOKEN_A");

        // ---- Part C: sign for TOKEN_A (the bound profileId) → must succeed ----
        {
            uint32 cawonce = 1;
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK2, TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            // Positive control: must not revert.
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }

        // ---- Part D: sign for TOKEN_B (different from bound profileId) → must revert ----
        {
            uint32 cawonce = 1; // fresh for TOKEN_B
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK2, TOKEN_B, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_B, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            // The token-scoped guard must fire.
            vm.expectRevert(CawActions.WrongProfileForSession.selector);
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }
    }

    // -----------------------------------------------------------------------
    // Test 3: CROSS-OWNER — a session registered by owner-2 cannot sign for a
    //         profile owned by owner-1. This is the real-world scenario that
    //         triggered the investigation: tokenId 44 and tokenId 45 on
    //         test2.caw.social are owned by DIFFERENT Pop-B addresses. A session
    //         key registered under 44's owner must be powerless to sign actions
    //         for 45 (and vice-versa). On-chain this is enforced because
    //         CawActions resolves the session via validSession(ownerOf(senderId),
    //         signer): when the signer's key was registered under a DIFFERENT
    //         owner, that lookup returns an EMPTY StoredSession (scopeBitmap == 0),
    //         so the scope check `scopeBitmap & (1<<actionType) == 0` reverts
    //         OutOfScope(). No cross-human impersonation is possible.
    // -----------------------------------------------------------------------

    uint256 constant OWNER2_PK   = 0xB0B2;
    uint256 constant SESSION_PK3 = 0x5E55103; // session key belonging to owner2

    /// @notice A session key registered ONLY under owner2 (who owns TOKEN_C) must
    ///         be rejected when used to sign an action whose senderId is TOKEN_A
    ///         (owned by owner1). Proves cross-owner isolation — the exact
    ///         "can someone sign as someone else?" guarantee.
    function test_crossOwner_foreignSessionRejected() public {
        address owner2     = vm.addr(OWNER2_PK);
        address sessionKey3 = vm.addr(SESSION_PK3);
        uint32  TOKEN_C    = 30; // owned by owner2

        // owner2 owns a SEPARATE profile, authenticated like the others.
        ledger.mint(TOKEN_C, owner2, "tokenC", uint64(block.number));
        ledger.auth(NETWORK_ID, TOKEN_C, address(0));

        // owner2 registers a wallet-scoped session key under THEIR OWN address.
        uint64 expiry  = uint64(block.timestamp + 7 days);
        uint8  scope   = 0xBF;
        uint256 spend  = 1_000_000 ether;
        _registerWalletSession(sessionKey3, OWNER2_PK, expiry, scope, spend, 0);

        // Sanity: the key IS registered under owner2 …
        (uint64 exp2, , , , , ) = ledger.sessions(owner2, sessionKey3);
        assertGt(exp2, 0, "owner2 session should exist");
        // … and is ABSENT under owner1 (the owner of TOKEN_A).
        (uint64 exp1, , , , , ) = ledger.sessions(owner, sessionKey3);
        assertEq(exp1, 0, "owner2 key must NOT be registered under owner1");

        // ---- Positive control: owner2's key signs for owner2's own TOKEN_C → OK ----
        {
            uint32 cawonce = 1;
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK3, TOKEN_C, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_C, TOKEN_A, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }

        // ---- The attack: owner2's key signs an action for TOKEN_A (owner1's) ----
        // The contract resolves the session via validSession(ownerOf(TOKEN_A)=owner1,
        // sessionKey3). Because sessionKey3 was never registered under owner1, that
        // lookup returns an EMPTY StoredSession (expiry == 0, scopeBitmap == 0). The
        // empty session is rejected at the expiry guard (CawActions.sol:569,
        // `if (s.expiry <= block.timestamp) revert SessionExpired()`) — which fires
        // before the scope check, since expiry 0 <= now. Either way the foreign key
        // is powerless: it can NOT sign as another owner. Cross-human impersonation
        // is impossible on-chain.
        {
            uint32 cawonce = 1;
            (uint8 v, bytes32 r, bytes32 s) = _signAction(SESSION_PK3, TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory packed = _packUnfollow(TOKEN_A, TOKEN_B, NETWORK_ID, cawonce);
            bytes memory sigs   = _packSingleSig(v, r, s);
            vm.expectRevert(CawActions.SessionExpired.selector);
            actions.processActions(VALIDATOR_ID, packed, sigs, 0, 0);
        }
    }
}
