// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title SmartEOA
/// @notice EIP-7702 delegate implementation for CAW user EOAs.
///         Every CAW Population-B user's secp256k1 EOA points at this single
///         deployed address via a type-0x04 EIP-7702 authorization.  Each user's
///         storage is separate (lives in their own EOA's storage slots) even though
///         they all share this implementation.
///
/// @dev IMMUTABILITY NOTICE: This contract is immutable once deployed.
///      There is no proxy, no upgradeability, no owner.  If a bug is found the
///      user submits a fresh EIP-7702 auth tuple pointing at a new implementation.
///      Every code review must treat this as final.
///
/// @dev EIP-7702 semantics: when a type-0x04 tx processes the authorization list
///      for a user's EOA, the EVM sets EOA.code = 0xef0100 || address(SmartEOA).
///      Subsequent calls to that EOA dispatch through this contract's function
///      selectors.  Storage reads/writes operate on the EOA's own storage slots,
///      not this contract's storage — this is the core 7702 isolation property.
///
/// @dev SECURITY: This contract owns user funds and can authorize L1 actions on
///      behalf of users.  All callers are traced in the Caller Audit at the bottom
///      of this file.  No function should be changed without re-running the audit.
contract SmartEOA {

    // =========================================================================
    // Constants
    // =========================================================================

    bytes4 private constant ERC1271_MAGIC_VALUE  = 0x1626ba7e;
    bytes4 private constant ERC1271_FAIL_VALUE   = 0xffffffff;

    /// @dev secp256k1 curve order / 2.  Sigs with s > this value are malleable
    ///      (the complementary sig (r, n-s, v^1) is equally valid).  We reject
    ///      high-s sigs to close the malleability surface after H-1 fixes nonce
    ///      replay; defence-in-depth per EIP-2 / OpenZeppelin ECDSA conventions.
    bytes32 private constant SECP256K1_N_HALF =
        bytes32(0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0);

    /// @dev EIP-7951 P-256 precompile (live on Ethereum mainnet since Fusaka,
    ///      Dec 2025).  Input: h(32) || r(32) || s(32) || qx(32) || qy(32) = 160 bytes.
    ///      Output on success: abi.encode(1) (32 bytes, value 1).
    ///      Output on failure / invalid input: empty bytes.
    ///      Gas cost: 6,900 per call.
    address private constant P256_PRECOMPILE = address(0x0100);

    /// @dev 24-hour timelock before a newly enrolled passkey becomes active.
    ///      During this window any enrolled (active) passkey or the ecdsaFallback
    ///      key can call cancelPendingPasskey to abort a malicious enrollment.
    ///      See §1 Scenario C of plan-smart-eoa-passkey-sponsorship.md.
    uint64  private constant PASSKEY_TIMELOCK = 86400; // seconds

    // =========================================================================
    // Custom errors
    // =========================================================================

    error AlreadyInitialized();
    error NotInitialized();
    error PasskeyAlreadyEnrolled();
    error PasskeyNotFound();
    error PasskeyNotPending();
    error InvalidCallerSig();
    error SelfRemovalRequiresLastActive();
    error ZeroAddress();
    error NotPermitted();
    error MinterCallFailed();

    // =========================================================================
    // Events
    // =========================================================================

    event Initialized(address indexed account);
    event PasskeyAdded(bytes32 indexed pubkeyHash, uint64 validFrom);
    event PasskeyActivated(bytes32 indexed pubkeyHash);
    event PasskeyRemoved(bytes32 indexed pubkeyHash);
    event PasskeyCancelled(bytes32 indexed pubkeyHash);
    event EcdsaFallbackRotated(address indexed newFallback);

    // =========================================================================
    // Storage layout
    // NOTE: Storage slots are per-EOA when this contract is used as a 7702
    //       delegate.  The layout must never be reordered across deployments —
    //       users' existing storage would be misread.
    // =========================================================================

    /// @dev Slot 0: initialization guard.
    bool private initialized;

    // Slot 1 (partial): ecdsaFallback — packed with initialized into slot 0?
    // Actually in Solidity, bool takes a full slot under naive layout.
    // With optimizer_runs=1 + via-ir solc packs adjacent small types.
    // To guarantee layout, we keep them as separate declarations.

    /// @dev Slot 1: ECDSA fallback key address.
    ///      This is the user's real secp256k1 address whose private key they
    ///      hold in encrypted cloud backup.  It is NOT a throwaway key.
    ///      See §1 Background: Population B's primary recovery anchor.
    address private ecdsaFallback;

    /// @dev Slot 2: enrolled P-256 pubkeys.
    ///      Key: keccak256(pubkeyX || pubkeyY).
    ///      PasskeyEntry.validFrom == 0  → active immediately (bootstrap path).
    ///      PasskeyEntry.validFrom > 0  → pending timelock; not usable until
    ///                                    block.timestamp >= validFrom.
    struct PasskeyEntry {
        bytes32 pubkeyX;
        bytes32 pubkeyY;
        uint64  enrolledAt;
        uint64  validFrom;   // 0 = active; >0 = pending (not yet usable)
    }
    mapping(bytes32 => PasskeyEntry) private passkeyPubkeys;

    /// @dev Iteration support — ordered list of all pubkey hashes (active + pending).
    bytes32[] private passkeyHashes;

    /// @dev Per-(verifyingContract, actionType) monotonic nonce counters.
    ///      Model mirrors EIP-2612: consuming nonce N invalidates all outstanding
    ///      permits at nonces < N for the same (contract, actionType) pair.
    ///      Keyed by verifying contract address so a v2 Minter starts its sequence
    ///      at 0 independently from v1 — no cross-version replay risk.
    mapping(address => mapping(uint8 => uint256)) private nonces;

    /// @notice Monotonic counter for management-operation signature anti-replay.
    /// @dev Bound into `_managementDigest`; incremented at the end of every successful
    ///      management call. One counter suffices since management ops are serialized.
    uint256 private managementNonce;

    // =========================================================================
    // ERC-1271
    // =========================================================================

    /// @notice ERC-1271 entry point — called by CawActions (line 1434-1439),
    ///         CawActionsERC1271 (_verifyERC1271), CawProfileMinter sponsor
    ///         entry points, and any other contract that wants to verify a
    ///         signature from a 7702-delegated EOA.
    ///
    /// @dev Dispatch rule (by blob length):
    ///      - sig.length == 65 → secp256k1 path: r[32] || s[32] || v[1].
    ///        Validate v ∈ {27, 28} BEFORE ecrecover to reject malleable sigs.
    ///        Return magic iff recovered == ecdsaFallback && ecdsaFallback != address(0).
    ///      - sig.length != 65 → WebAuthn P-256 path: ABI-decoded assertion blob.
    ///        Walk enrolled passkeys; skip pending (validFrom > now).
    ///        Return magic on first match, fail value if none match.
    ///
    ///      NEVER reverts.  Wrap every non-pure path in a try-style guard.
    ///      This is required by the ERC-1271 calling convention: callers like
    ///      CawActions use `staticcall` and check for the magic value, not revert.
    ///
    /// @param digest  The EIP-712 digest the caller wants verified.
    /// @param sig     Signature blob — either 65-byte secp256k1 or WebAuthn.
    /// @return        0x1626ba7e on success, 0xffffffff on failure.
    function isValidSignature(bytes32 digest, bytes calldata sig)
        external
        view
        returns (bytes4)
    {
        if (sig.length == 65) {
            return _verifySig65(digest, sig) ? ERC1271_MAGIC_VALUE : ERC1271_FAIL_VALUE;
        }
        // Wrap WebAuthn path in a try/catch equivalent (assembly) so that any
        // ABI decode failure, out-of-bounds access, or precompile failure
        // surfaces as 0xffffffff instead of a revert.
        return _verifyWebAuthnSafe(digest, sig);
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    /// @notice One-shot initialization.  MUST be called in the same type-0x04 tx
    ///         that processes the EIP-7702 authorization list, so the account is
    ///         never in a half-initialized state.
    ///
    ///         CEI order (per §5 of plan):
    ///           1. Guard: revert if already initialized.
    ///           2. Write initialized = true (prevents re-entry via Minter callback).
    ///           3. Enroll initial passkey (validFrom = 0, active immediately).
    ///           4. Set ecdsaFallback.
    ///           5. Forward msg.value to minterContract if provided.
    ///
    /// @param pubkeyX          P-256 passkey X coordinate.
    /// @param pubkeyY          P-256 passkey Y coordinate.
    /// @param ecdsaFallbackAddr secp256k1 address held in user's encrypted backup.
    /// @param minterContract   CawProfileMinter address, or address(0) for standalone test.
    /// @param mintCalldata     Encoded mintAndDepositSponsored call, or empty for standalone.
    function initialize(
        bytes32 pubkeyX,
        bytes32 pubkeyY,
        address ecdsaFallbackAddr,
        address payable minterContract,
        bytes calldata mintCalldata
    ) external payable {
        // Step 1 + 2: guard then set (CEI — state written before external call).
        if (initialized) revert AlreadyInitialized();
        initialized = true;

        // Step 3: enroll initial passkey — active immediately (validFrom = 0).
        bytes32 h = keccak256(abi.encodePacked(pubkeyX, pubkeyY));
        passkeyPubkeys[h] = PasskeyEntry({
            pubkeyX:    pubkeyX,
            pubkeyY:    pubkeyY,
            enrolledAt: uint64(block.timestamp),
            validFrom:  0   // active from enrollment, no timelock on bootstrap
        });
        passkeyHashes.push(h);

        // Step 4: set fallback key.
        if (ecdsaFallbackAddr == address(0)) revert ZeroAddress();
        ecdsaFallback = ecdsaFallbackAddr;

        emit Initialized(address(this));

        // Step 5: forward to Minter if provided.
        // Design note: minterContract == address(0) is the standalone-test path.
        // In production, the Minter will staticcall back to isValidSignature on
        // address(this); because initialized=true and the passkey is enrolled
        // (steps 2-3 above ran before this external call), the callback succeeds.
        // This is the single-tx bootstrap design proven by EIP7702Bootstrap.t.sol.
        if (minterContract != address(0)) {
            (bool ok, ) = minterContract.call{value: msg.value}(mintCalldata);
            if (!ok) revert MinterCallFailed();
        }
    }

    // =========================================================================
    // Passkey management
    // =========================================================================

    /// @notice Enroll a new passkey.  The new key is placed in a 24-hour timelock
    ///         before it becomes usable, giving the legitimate user a window to
    ///         cancel a malicious enrollment (§1 Scenario C).
    ///
    /// @dev Authorization: caller must present a valid sig from:
    ///        (a) an already-enrolled ACTIVE passkey, OR
    ///        (b) ecdsaFallback if no active passkeys exist (all removed —
    ///            the bootstrap-recovery case).
    ///
    /// @dev NOTE on passkeyCount vs activeCount: we do NOT maintain a running
    ///      counter.  Active count is computed on-the-fly by iterating
    ///      passkeyHashes.  This is necessary because pending keys must not
    ///      contribute to quorum or removal authority (a user could otherwise
    ///      addPasskey then immediately use the still-pending key as a co-signer
    ///      to removePasskey someone else — defeating the timelock).
    ///      The maximum enrolled key count is expected to be small (1-5),
    ///      so O(N) iteration is acceptable.
    ///
    /// @param newPubkeyX  P-256 X coordinate of the new passkey.
    /// @param newPubkeyY  P-256 Y coordinate of the new passkey.
    /// @param callerSig   65-byte secp256k1 sig OR WebAuthn blob from an active key.
    function addPasskey(bytes32 newPubkeyX, bytes32 newPubkeyY, bytes calldata callerSig)
        external
    {
        if (!initialized) revert NotInitialized();

        bytes32 newHash = keccak256(abi.encodePacked(newPubkeyX, newPubkeyY));

        // Reject if already enrolled or pending.
        if (passkeyPubkeys[newHash].pubkeyX != 0) revert PasskeyAlreadyEnrolled();

        // Build the authorization digest for this management call.
        bytes32 digest = _managementDigest("addPasskey", abi.encode(newPubkeyX, newPubkeyY));

        // Authorize: active passkey or ecdsaFallback (if no active keys).
        uint256 activeCount = _activePasskeyCount();
        if (activeCount == 0) {
            // Bootstrap-recovery path: no active passkeys, authorize via secp256k1.
            if (!_verifySig65(digest, callerSig)) revert InvalidCallerSig();
        } else {
            // Normal path: require an active passkey sig.
            if (!_verifyAnyActivePasskey(digest, callerSig)) revert InvalidCallerSig();
        }

        // Enroll with timelock.
        uint64 validFrom = uint64(block.timestamp) + PASSKEY_TIMELOCK;
        passkeyPubkeys[newHash] = PasskeyEntry({
            pubkeyX:    newPubkeyX,
            pubkeyY:    newPubkeyY,
            enrolledAt: uint64(block.timestamp),
            validFrom:  validFrom
        });
        passkeyHashes.push(newHash);

        unchecked { ++managementNonce; }
        emit PasskeyAdded(newHash, validFrom);
    }

    /// @notice Remove an enrolled passkey.
    ///
    /// @dev Authorization matrix (§1 Scenario D):
    ///
    ///      callerSig is 65-byte secp256k1 from ecdsaFallback:
    ///        → unconditional removal.  No quorum check.  This is the owner's
    ///          last-resort key; it must be able to clean up a fully-compromised
    ///          passkey set (§1 Scenario F).
    ///
    ///      callerSig is WebAuthn from a passkey:
    ///        → If signer == target AND activeCount == 1: self-removal allowed.
    ///          CONTRACT LAYER NOTE: N=1 self-removal is deliberately permitted
    ///          at the contract layer.  The FE MUST require vault-password entry
    ///          before submitting removePasskey when enrolled count == 1.  See
    ///          §7 test 25 and §1 Scenario D FE-layer note.
    ///        → If signer != target AND activeCount >= 2: co-signer removal.
    ///          Any active non-target passkey may approve.
    ///        → If signer == target AND activeCount >= 2: self-removal NOT allowed
    ///          (use ecdsaFallback or have another key remove you).
    ///
    ///      v1 LIMITATION: For activeCount >= 3, a SINGLE co-signer suffices.
    ///      v2 hardens this with true ceil(activeCount/2) quorum — multiple
    ///      co-signer sigs required.  Document here so it is not forgotten.
    ///
    /// @param targetPubkeyHash  keccak256(x || y) of the key to remove.
    /// @param callerSig         65-byte secp256k1 OR WebAuthn blob.
    function removePasskey(bytes32 targetPubkeyHash, bytes calldata callerSig)
        external
    {
        if (!initialized) revert NotInitialized();

        PasskeyEntry storage target = passkeyPubkeys[targetPubkeyHash];
        if (target.pubkeyX == 0) revert PasskeyNotFound();

        bytes32 digest = _managementDigest("removePasskey", abi.encode(targetPubkeyHash));

        // secp256k1 ecdsaFallback path: unconditional removal.
        if (callerSig.length == 65 && _verifySig65(digest, callerSig)) {
            _deletePasskey(targetPubkeyHash);
            emit PasskeyRemoved(targetPubkeyHash);
            unchecked { ++managementNonce; }
            return;
        }

        // Passkey path.
        uint256 activeCount = _activePasskeyCount();
        (bytes32 signerHash, bool verified) = _verifyActivePasskeyGetHash(digest, callerSig);
        if (!verified) revert InvalidCallerSig();

        if (signerHash == targetPubkeyHash) {
            // Self-removal: only allowed if this is the ONLY active key.
            if (activeCount != 1) revert SelfRemovalRequiresLastActive();
        } else {
            // Co-signer removal: signer must not be the target (enforced above
            // by signerHash != targetPubkeyHash) and activeCount >= 2.
            // If activeCount == 1 and signer != target, the target must be pending
            // (not active), which means signerHash would have been the only active
            // key — allowed.  The target entry exists (checked above) so it may be
            // pending; we delete it regardless.
            if (activeCount < 1) revert InvalidCallerSig();
        }

        _deletePasskey(targetPubkeyHash);
        emit PasskeyRemoved(targetPubkeyHash);
        unchecked { ++managementNonce; }
    }

    /// @notice Cancel a passkey that is still in its timelock window.
    ///
    /// @dev Any currently-enrolled ACTIVE passkey OR ecdsaFallback can cancel.
    ///      The target must be in pending state (validFrom > block.timestamp).
    ///      Used to abort a malicious enrollment before it activates (§1 Scenario C).
    ///
    /// @param targetPubkeyHash  Hash of the pending passkey to cancel.
    /// @param callerSig         65-byte secp256k1 OR WebAuthn blob from active key.
    function cancelPendingPasskey(bytes32 targetPubkeyHash, bytes calldata callerSig)
        external
    {
        if (!initialized) revert NotInitialized();

        PasskeyEntry storage target = passkeyPubkeys[targetPubkeyHash];
        if (target.pubkeyX == 0) revert PasskeyNotFound();
        // Must be pending (timelock not yet elapsed).
        if (target.validFrom == 0 || target.validFrom <= block.timestamp)
            revert PasskeyNotPending();

        bytes32 digest = _managementDigest("cancelPendingPasskey", abi.encode(targetPubkeyHash));

        // Accept secp256k1 ecdsaFallback or any active passkey.
        bool authorized;
        if (callerSig.length == 65) {
            authorized = _verifySig65(digest, callerSig);
        } else {
            authorized = _verifyAnyActivePasskey(digest, callerSig);
        }
        if (!authorized) revert InvalidCallerSig();

        _deletePasskey(targetPubkeyHash);
        unchecked { ++managementNonce; }
        emit PasskeyCancelled(targetPubkeyHash);
    }

    // =========================================================================
    // ECDSA fallback rotation
    // =========================================================================

    /// @notice Replace the secp256k1 ECDSA fallback key.
    ///         Requires a valid WebAuthn sig from an enrolled active passkey.
    ///         After this call, the OLD ecdsaFallback no longer validates.
    ///         Use case: §1 Scenario G — backup blob stolen; rotate to a fresh key.
    ///
    /// @param newFallback  New secp256k1 address (from a fresh encrypted backup).
    /// @param callerSig    WebAuthn blob from any enrolled active passkey.
    function rotateEcdsaFallback(address newFallback, bytes calldata callerSig)
        external
    {
        if (!initialized) revert NotInitialized();
        if (newFallback == address(0)) revert ZeroAddress();

        bytes32 digest = _managementDigest("rotateEcdsaFallback", abi.encode(newFallback));

        // Rotation requires a passkey sig (not secp256k1) — if the secp256k1 key
        // was the one that needed rotating, having it authorize its own replacement
        // would be circular.  Use a passkey to rotate the secp256k1 fallback.
        if (!_verifyAnyActivePasskey(digest, callerSig)) revert InvalidCallerSig();

        ecdsaFallback = newFallback;
        unchecked { ++managementNonce; }
        emit EcdsaFallbackRotated(newFallback);
    }

    // =========================================================================
    // Nonce management
    // =========================================================================

    /// @notice Read the current nonce for a (verifyingContract, actionType) pair.
    ///         Called by sponsor server / FE when assembling an EIP-712 permit digest.
    function nonceOf(address verifyingContract, uint8 actionType)
        external
        view
        returns (uint256)
    {
        return nonces[verifyingContract][actionType];
    }

    /// @notice Read the current management nonce.
    ///         Called by FE / sponsor server when constructing management-op sigs
    ///         (addPasskey, removePasskey, cancelPendingPasskey, rotateEcdsaFallback).
    ///         Bound into every management digest to prevent replay of captured sigs.
    function managementNonceOf() external view returns (uint256) {
        return managementNonce;
    }

    /// @notice Consume (increment) the nonce for a (verifyingContract, actionType) pair.
    ///
    /// @dev ACCESS CONTROL — gated to msg.sender == verifyingContract.
    ///
    ///      Rationale: The Minter calls consumeNonce(address(this), ACTION_X) which
    ///      passes because msg.sender == address(Minter) == verifyingContract.
    ///
    ///      Without this gate, a race exists: an attacker could call consumeNonce
    ///      between the Minter's nonceOf() read and its "require(permitNonce ==
    ///      currentNonce)" check, bumping the nonce and causing the Minter's
    ///      legitimate tx to revert ("Nonce mismatch").  This is a real DoS vector
    ///      even though it does not move funds — it causes the user's sponsored
    ///      operation to fail and requires a fresh permit sig.
    ///
    ///      With this gate, only the Minter itself can call consumeNonce(Minter, X),
    ///      so the race window collapses.  The gate is verifyingContract-specific:
    ///      a malicious contract can still call consumeNonce(maliciousContract, X)
    ///      but that only burns nonces in its own sequence — it has no effect on the
    ///      Minter's sequence.
    ///
    /// @param verifyingContract  The contract whose nonce sequence to advance.
    /// @param actionType         The action type whose nonce to advance.
    function consumeNonce(address verifyingContract, uint8 actionType)
        external
    {
        if (msg.sender != verifyingContract) revert NotPermitted();
        unchecked { ++nonces[verifyingContract][actionType]; }
    }

    // =========================================================================
    // ETH receive
    // =========================================================================

    /// @notice Accept ETH (needed for the payable initialize sponsor path and
    ///         for any future self-funded operations by Population B users).
    receive() external payable {}

    // =========================================================================
    // Internal helpers — secp256k1
    // =========================================================================

    /// @dev Verify a 65-byte secp256k1 sig against ecdsaFallback.
    ///      Returns true only if ecdsaFallback is set and the recovered address matches.
    ///      Rejects malleable v values (v must be 27 or 28) BEFORE calling ecrecover.
    ///      ecrecover returns address(0) on invalid input — we explicitly check for it
    ///      to prevent address(0) ecdsaFallback bypass.
    function _verifySig65(bytes32 digest, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8   v = uint8(sig[64]);
        // Reject malleable v without calling ecrecover (v=26 attack surface).
        if (v != 27 && v != 28) return false;
        // Reject high-s sigs (malleability hardening per EIP-2).
        if (uint256(s) > uint256(SECP256K1_N_HALF)) return false;
        address recovered = ecrecover(digest, v, r, s);
        address fb = ecdsaFallback;
        return recovered != address(0) && fb != address(0) && recovered == fb;
    }

    // =========================================================================
    // Internal helpers — WebAuthn / P-256
    // =========================================================================

    /// @dev Safe wrapper around _verifyWebAuthn that returns ERC1271_FAIL_VALUE
    ///      on any revert instead of propagating it.
    ///
    ///      Solidity does not support try/catch on internal calls, so we use a
    ///      staticcall to ourselves.  The inner call is pure/view; the staticcall
    ///      succeeds or fails silently.
    ///
    ///      NOTE: An alternative is to mark _verifyWebAuthn as a separate external
    ///      function, but that leaks it to external callers.  The self-staticcall
    ///      pattern keeps the surface clean.
    function _verifyWebAuthnSafe(bytes32 digest, bytes calldata sig)
        internal
        view
        returns (bytes4)
    {
        // Encode the inner call: _verifyWebAuthn(digest, sig)
        // We call ourselves with the internal helper's selector.
        // Since this is a staticcall to ourselves, storage reads work fine.
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(this._verifyWebAuthnExternal.selector, digest, sig)
        );
        if (!ok || ret.length < 32) return ERC1271_FAIL_VALUE;
        bytes4 result = abi.decode(ret, (bytes4));
        return result;
    }

    /// @dev External wrapper for _verifyWebAuthn, called via self-staticcall to
    ///      isolate reverts.  NOT part of the public API — only callable via
    ///      self-staticcall from _verifyWebAuthnSafe.
    ///
    ///      This function is public only because Solidity requires it for the
    ///      selector reference above.  External callers get no benefit from calling
    ///      it directly: it returns ERC1271_FAIL_VALUE on any sig they forge, same
    ///      as isValidSignature.  The function has no state-mutating ability.
    function _verifyWebAuthnExternal(bytes32 digest, bytes calldata sig)
        external
        view
        returns (bytes4)
    {
        return _verifyWebAuthn(digest, sig);
    }

    /// @dev Core WebAuthn verification logic.
    ///      Format of the `sig` blob (ABI-encoded, as produced by wagmi/webauthn libs):
    ///
    ///      abi.encode(
    ///          bytes  authenticatorData,
    ///          bytes  clientDataJSON,
    ///          bytes32 r,
    ///          bytes32 s
    ///      )
    ///
    ///      IMPORTANT: This encoding convention is the standard wagmi WebAuthn
    ///      assertion output.  If the FE team uses a different encoder
    ///      (e.g., abi.encode with a tuple struct), the blob order or dynamic
    ///      encoding may differ.  The FE team MUST confirm this convention before
    ///      production deployment.  See §2 of plan-smart-eoa-passkey-sponsorship.md,
    ///      "WebAuthn signature format" section.
    ///
    ///      Steps:
    ///      1. ABI-decode authenticatorData, clientDataJSON, r, s from sig.
    ///      2. Parse "challenge" field from clientDataJSON.
    ///      3. Base64url-decode the challenge and compare to digest.
    ///      4. Compute sha256(authenticatorData || sha256(clientDataJSON)).
    ///      5. Call P-256 precompile at 0x0100 with h || r || s || qx || qy.
    ///      6. On first matching active passkey, return ERC1271_MAGIC_VALUE.
    function _verifyWebAuthn(bytes32 digest, bytes calldata sig)
        internal
        view
        returns (bytes4)
    {
        // Step 1: ABI-decode.
        (
            bytes memory authenticatorData,
            bytes memory clientDataJSON,
            bytes32 r,
            bytes32 s
        ) = abi.decode(sig, (bytes, bytes, bytes32, bytes32));

        // Step 2 + 3: parse challenge and verify it equals digest.
        if (!_challengeMatchesDigest(clientDataJSON, digest)) {
            return ERC1271_FAIL_VALUE;
        }

        // Step 4: compute the P-256 message hash.
        bytes32 h = sha256(
            abi.encodePacked(authenticatorData, sha256(clientDataJSON))
        );

        // Step 5 + 6: try each active enrolled passkey.
        uint256 len = passkeyHashes.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 pkHash = passkeyHashes[i];
            PasskeyEntry storage entry = passkeyPubkeys[pkHash];
            // Skip: key removed (pubkeyX cleared) — should not happen because
            // _deletePasskey also removes from passkeyHashes, but guard anyway.
            if (entry.pubkeyX == 0) {
                unchecked { ++i; }
                continue;
            }
            // Skip: pending passkey (timelock not yet elapsed).
            if (entry.validFrom != 0 && block.timestamp < entry.validFrom) {
                unchecked { ++i; }
                continue;
            }
            // Try P-256 verify.
            if (_verifyP256(h, r, s, entry.pubkeyX, entry.pubkeyY)) {
                return ERC1271_MAGIC_VALUE;
            }
            unchecked { ++i; }
        }
        return ERC1271_FAIL_VALUE;
    }

    /// @dev Verify a P-256 signature via EIP-7951 precompile at 0x0100.
    ///      Input: h(32) || r(32) || s(32) || qx(32) || qy(32) = 160 bytes.
    ///      Output on success: 32 bytes with value 1.
    ///      Output on failure: 0 bytes.
    ///      Gas: 6,900.
    function _verifyP256(bytes32 h, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        bytes memory input = abi.encodePacked(h, r, s, qx, qy);
        (bool ok, bytes memory result) = P256_PRECOMPILE.staticcall(input);
        return ok && result.length == 32 && uint256(bytes32(result)) == 1;
    }

    /// @dev Parse the "challenge" field from clientDataJSON and verify it matches
    ///      the ERC-1271 digest.
    ///
    ///      clientDataJSON is a UTF-8 JSON string like:
    ///      {"type":"webauthn.get","challenge":"<base64url>","origin":"..."}
    ///
    ///      We search for `"challenge":"` as the key prefix and extract bytes
    ///      up to the closing `"`.  The extracted string is base64url-decoded
    ///      and compared to the 32-byte digest.
    ///
    ///      This parsing is intentionally minimal and handles the standard wagmi
    ///      encoding.  A malformed or adversarially crafted clientDataJSON that
    ///      places the challenge key in a non-standard position (e.g., inside
    ///      a nested object) will fail to parse and return false.  That is the
    ///      correct secure default — reject anything non-standard.
    function _challengeMatchesDigest(bytes memory clientDataJSON, bytes32 digest)
        internal
        pure
        returns (bool)
    {
        // Search for `"challenge":"` in clientDataJSON.
        bytes memory needle = bytes('"challenge":"');
        uint256 needleLen = needle.length;  // 13
        uint256 jsonLen = clientDataJSON.length;

        uint256 start = type(uint256).max;
        // Linear scan — safe because clientDataJSON is attacker-supplied but
        // bounded by ABI-decode.  In practice < 512 bytes.
        for (uint256 i = 0; i + needleLen <= jsonLen; ) {
            bool found = true;
            for (uint256 j = 0; j < needleLen; ) {
                if (clientDataJSON[i + j] != needle[j]) {
                    found = false;
                    break;
                }
                unchecked { ++j; }
            }
            if (found) {
                start = i + needleLen;
                break;
            }
            unchecked { ++i; }
        }
        if (start == type(uint256).max) return false;

        // Extract base64url chars up to closing '"'.
        uint256 end = start;
        while (end < jsonLen && clientDataJSON[end] != '"') {
            unchecked { ++end; }
        }
        if (end == start || end >= jsonLen) return false;

        // Base64url-decode the challenge string.
        uint256 encodedLen = end - start;
        bytes memory decoded = _base64urlDecode(clientDataJSON, start, encodedLen);

        // The decoded challenge must be exactly 32 bytes equal to the digest.
        if (decoded.length != 32) return false;
        return bytes32(decoded) == digest;
    }

    /// @dev Base64url decode a slice of `data[offset..offset+length]` into bytes.
    ///      Base64url alphabet: A-Z (0-25), a-z (26-51), 0-9 (52-61), '-' (62), '_' (63).
    ///      Unpadded is preferred per RFC 4648 §5; padded input ('=') is trimmed before
    ///      decoding so both browser-produced (unpadded) and non-browser (padded) inputs work.
    ///      Returns empty bytes on invalid input.
    function _base64urlDecode(bytes memory data, uint256 offset, uint256 length)
        internal
        pure
        returns (bytes memory)
    {
        if (length == 0) return new bytes(0);

        // Strip trailing '=' padding chars (RFC 4648 §5: padding is optional in base64url).
        while (length > 0 && uint8(data[offset + length - 1]) == uint8(bytes1('='))) {
            unchecked { --length; }
        }
        if (length == 0) return new bytes(0);

        // Computed output length: floor((length * 6) / 8) accounting for padding.
        // For 32 bytes input: base64url length = ceil(32*8/6) = 43 chars (unpadded).
        // With padding it's 44 chars.
        uint256 outLen = (length * 6) / 8;
        bytes memory out = new bytes(outLen);

        uint256 inIdx = offset;
        uint256 outIdx = 0;
        uint256 end = offset + length;

        // Process 4-byte groups (standard base64 block size).
        while (inIdx + 4 <= end) {
            uint8 b0 = _b64urlVal(uint8(data[inIdx]));
            uint8 b1 = _b64urlVal(uint8(data[inIdx + 1]));
            uint8 b2 = _b64urlVal(uint8(data[inIdx + 2]));
            uint8 b3 = _b64urlVal(uint8(data[inIdx + 3]));

            if (b0 == 255 || b1 == 255 || b2 == 255 || b3 == 255) return new bytes(0);

            if (outIdx < outLen) out[outIdx++] = bytes1((b0 << 2) | (b1 >> 4));
            if (outIdx < outLen) out[outIdx++] = bytes1((b1 << 4) | (b2 >> 2));
            if (outIdx < outLen) out[outIdx++] = bytes1((b2 << 6) | b3);

            unchecked { inIdx += 4; }
        }

        // Handle remaining 2 or 3 chars (tail of base64url without padding).
        uint256 remaining = end - inIdx;
        if (remaining == 2) {
            uint8 b0 = _b64urlVal(uint8(data[inIdx]));
            uint8 b1 = _b64urlVal(uint8(data[inIdx + 1]));
            if (b0 == 255 || b1 == 255) return new bytes(0);
            if (outIdx < outLen) out[outIdx] = bytes1((b0 << 2) | (b1 >> 4));
        } else if (remaining == 3) {
            uint8 b0 = _b64urlVal(uint8(data[inIdx]));
            uint8 b1 = _b64urlVal(uint8(data[inIdx + 1]));
            uint8 b2 = _b64urlVal(uint8(data[inIdx + 2]));
            if (b0 == 255 || b1 == 255 || b2 == 255) return new bytes(0);
            if (outIdx < outLen) out[outIdx++] = bytes1((b0 << 2) | (b1 >> 4));
            if (outIdx < outLen) out[outIdx]   = bytes1((b1 << 4) | (b2 >> 2));
        } else if (remaining == 1) {
            // 1 remaining base64 char = only 6 bits, cannot decode to a full byte.
            // This should not happen for a valid 32-byte challenge encoding.
            return new bytes(0);
        }

        return out;
    }

    /// @dev Map a base64url ASCII char to its 6-bit value, or 255 on error.
    ///      '=' padding chars return 255 (invalid).  _base64urlDecode strips trailing
    ///      '=' before calling this function, so '=' never reaches here on valid input.
    function _b64urlVal(uint8 c) internal pure returns (uint8) {
        if (c >= 65 && c <= 90)  return c - 65;        // A-Z: 0-25
        if (c >= 97 && c <= 122) return c - 71;        // a-z: 26-51 (97-71=26)
        if (c >= 48 && c <= 57)  return c + 4;         // 0-9: 52-61 (48+4=52)
        if (c == 45)             return 62;             // '-'
        if (c == 95)             return 63;             // '_'
        return 255;                                     // invalid (includes '=' padding)
    }

    // =========================================================================
    // Internal helpers — passkey iteration
    // =========================================================================

    /// @dev Count active (non-pending, non-deleted) passkeys.
    ///      active ≡ entry exists (pubkeyX != 0) AND (validFrom == 0 OR block.timestamp >= validFrom).
    function _activePasskeyCount() internal view returns (uint256 count) {
        uint256 len = passkeyHashes.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 h = passkeyHashes[i];
            PasskeyEntry storage e = passkeyPubkeys[h];
            if (e.pubkeyX != 0 && (e.validFrom == 0 || block.timestamp >= e.validFrom)) {
                unchecked { ++count; }
            }
            unchecked { ++i; }
        }
    }

    /// @dev Verify that callerSig is a valid WebAuthn sig from ANY active passkey.
    ///      Returns true if any active passkey verifies the sig.
    function _verifyAnyActivePasskey(bytes32 digest, bytes calldata callerSig)
        internal
        view
        returns (bool)
    {
        (, bool verified) = _verifyActivePasskeyGetHash(digest, callerSig);
        return verified;
    }

    /// @dev Same as _verifyAnyActivePasskey but also returns the hash of the
    ///      passkey that signed (for co-signer identity checks in removePasskey).
    ///      Returns (bytes32(0), false) if no active passkey verified.
    function _verifyActivePasskeyGetHash(bytes32 digest, bytes calldata callerSig)
        internal
        view
        returns (bytes32 signerHash, bool verified)
    {
        // Decode WebAuthn blob to extract r, s, authenticatorData, clientDataJSON.
        // We need per-key verification (try each key's pubkey against the same sig).
        bytes memory authenticatorData;
        bytes memory clientDataJSON;
        bytes32 r;
        bytes32 s;

        // ABI-decode — if this fails, no active passkey can verify.
        try this._decodeWebAuthn(callerSig) returns (
            bytes memory ad,
            bytes memory cdj,
            bytes32 _r,
            bytes32 _s
        ) {
            authenticatorData = ad;
            clientDataJSON = cdj;
            r = _r;
            s = _s;
        } catch {
            return (bytes32(0), false);
        }

        // Verify challenge matches digest.
        if (!_challengeMatchesDigest(clientDataJSON, digest)) {
            return (bytes32(0), false);
        }

        // Compute the message hash.
        bytes32 h = sha256(
            abi.encodePacked(authenticatorData, sha256(clientDataJSON))
        );

        uint256 len = passkeyHashes.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 pkHash = passkeyHashes[i];
            PasskeyEntry storage entry = passkeyPubkeys[pkHash];
            if (entry.pubkeyX == 0) {
                unchecked { ++i; }
                continue;
            }
            // Skip pending keys — pending keys cannot authorize management operations.
            if (entry.validFrom != 0 && block.timestamp < entry.validFrom) {
                unchecked { ++i; }
                continue;
            }
            if (_verifyP256(h, r, s, entry.pubkeyX, entry.pubkeyY)) {
                return (pkHash, true);
            }
            unchecked { ++i; }
        }
        return (bytes32(0), false);
    }

    /// @dev External-facing ABI decode helper, called via try/catch from
    ///      _verifyActivePasskeyGetHash.  Solidity try/catch only works on
    ///      external calls, so we expose this as an external view.
    ///      NOT intended as a public API.
    function _decodeWebAuthn(bytes calldata sig)
        external
        pure
        returns (bytes memory, bytes memory, bytes32, bytes32)
    {
        return abi.decode(sig, (bytes, bytes, bytes32, bytes32));
    }

    // =========================================================================
    // Internal helpers — passkey deletion
    // =========================================================================

    /// @dev Delete a passkey entry from storage and from the passkeyHashes array.
    ///      Uses swap-and-pop to avoid O(N) shifting.
    ///      NOTE: Does NOT emit PasskeyRemoved — callers are responsible for emitting
    ///      the appropriate event (PasskeyRemoved for removePasskey, PasskeyCancelled
    ///      for cancelPendingPasskey).  This avoids double-event on cancel (L-3 fix).
    function _deletePasskey(bytes32 h) internal {
        // Clear the mapping entry.
        delete passkeyPubkeys[h];

        // Remove from the array via swap-and-pop.
        uint256 len = passkeyHashes.length;
        for (uint256 i = 0; i < len; ) {
            if (passkeyHashes[i] == h) {
                passkeyHashes[i] = passkeyHashes[len - 1];
                passkeyHashes.pop();
                break;
            }
            unchecked { ++i; }
        }
    }

    // =========================================================================
    // Internal helpers — management digest
    // =========================================================================

    /// @dev Build a replay-protected digest for management calls (addPasskey,
    ///      removePasskey, cancelPendingPasskey, rotateEcdsaFallback).
    ///
    ///      The digest is constructed to be specific to:
    ///      - This contract's address (address(this) = the user's EOA, not the
    ///        implementation address — critical for EIP-7702 security).
    ///      - The current chain ID (prevents cross-chain replay).
    ///      - The operation name.
    ///      - The operation parameters.
    ///
    ///      Format: keccak256("\x19\x01" || domainSep || structHash)
    ///      where domainSep = keccak256("SmartEOA" || chainId || address(this))
    ///      and   structHash = keccak256(opName || params)
    ///
    ///      NOTE: address(this) in the context of a 7702-delegated call is the
    ///      user's EOA address, not the SmartEOA implementation address.  This
    ///      is correct — we want the digest to be account-specific.
    function _managementDigest(string memory opName, bytes memory params)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSep = keccak256(abi.encodePacked(
            "SmartEOA",
            block.chainid,
            address(this)   // EOA address (per-user), not implementation address
        ));
        bytes32 structHash = keccak256(abi.encodePacked(
            keccak256(bytes(opName)),
            keccak256(params),
            managementNonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    // =========================================================================
    // Caller audit
    // =========================================================================
    //
    // Every external caller of this contract, traced at implementation time:
    //
    // isValidSignature(bytes32, bytes):
    //   - CawActions._checkERC1271 (line 1434-1440): passes sig as encodePacked(r,s,v)
    //     = 65 bytes.  secp256k1 path fires.  Gas limit: 50,000.
    //   - CawActionsERC1271._verifyERC1271 (line 309-315): passes sig verbatim
    //     from caller.  May be 65-byte or WebAuthn.  Gas limit: 50,000 (ERC1271_GAS_LIMIT).
    //   - CawProfileMinter.mintAndDepositSponsored (planned): passes WebAuthn or
    //     65-byte sig assembled by sponsor server.  Gas limit: ≥30,000 (MockMinter
    //     uses 30,000; real Minter should use ≥50,000 to cover P-256 path at ~8,000).
    //   - Any future ERC-1271 consumer: same isValidSignature(bytes32,bytes) ABI.
    //
    // initialize(bytes32, bytes32, address, address payable, bytes):
    //   - Called once by the sponsor server's type-0x04 tx as the tx body.
    //   - NOT callable again (AlreadyInitialized guard).
    //
    // addPasskey, removePasskey, cancelPendingPasskey, rotateEcdsaFallback:
    //   - Called by the user (from their FE) after authentication.
    //   - Each requires a valid sig from an enrolled active key or ecdsaFallback.
    //
    // consumeNonce(address, uint8):
    //   - Called by CawProfileMinter (planned) after verifying ERC-1271.
    //   - Gated: msg.sender must equal the verifyingContract param.
    //
    // nonceOf(address, uint8):
    //   - Read-only.  Called by FE / sponsor server when assembling permits.
    //
    // managementNonceOf():
    //   - Read-only.  Called by FE / sponsor server when assembling management-op sigs.
    //
    // _verifyWebAuthnExternal(bytes32, bytes) and _decodeWebAuthn(bytes):
    //   - These appear external in the ABI but are only useful via self-staticcall.
    //   - External callers cannot extract value from them: they return fail values
    //     for sigs they did not sign.
    //
}
