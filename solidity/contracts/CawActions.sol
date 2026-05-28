// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// CawActions — two paths into the same state machine
// =============================================================================
//
// `processActions`               sig path. Validator submits packed actions +
//                                grouped sigs; the contract recovers each
//                                signer with ecrecover and runs the EIP-712
//                                check inline. All-or-nothing: any bad sig or
//                                used cawonce reverts the whole batch.
//
// `processActionsWithZkSigs`     ZK path. The same packed actions + grouped
//                                sigs, plus a Groth16 proof that the off-chain
//                                prover already recovered every signer
//                                correctly. The contract trusts the proof's
//                                signersHash commitment and skips ecrecover.
//                                Skip-don't-revert: cawonce conflicts at
//                                runtime drop just the conflicting slots,
//                                the rest of the batch runs.
//
// Why both: the ZK path is cheaper per action but pays a fixed verifier cost
// (~265K gas on Base Sepolia, measured). The break-even versus the sig path
// is around **n ≈ 70 actions per batch** today (singleton sig groups, real
// prod conditions). Below that, the sig path wins; above that, the ZK path
// wins. Validators free to use either at their discretion; the on-chain
// state transitions are identical.
//
// The ZK path is OPTIONAL — an installation can deploy with `_zkVerifier =
// address(0)` and `processActionsWithZkSigs` reverts with "ZK path not
// configured". Both `_zkVerifier` and `_zkProgramVKey` are immutable; rotating
// either requires a fresh CawActions deployment, which is by design — they're
// part of the verification trust root.
//
// Detailed write-up: docs/ZK_SIG_PATH.md.
// Circuit + prover infrastructure: solidity/zk/sig-recovery/.
// =============================================================================

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

import "./CawProfileL2.sol";
import "./interfaces/ICawCapOracle.sol";
import { ISP1Verifier } from "./IZKActionsVerifier.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Ownable {
  error NotSibling();
  error OnlySelf();
  error NotCapOracle();
  error NoActions();
  error TooManyActions();
  error BadSigGroupCount();
  error SigsIncomplete();
  error TrailingBytes();
  error EmptyGroup();
  error GroupOverflows();
  error MixedNetworks();
  error ZkNotConfigured();
  error ZkSignersMismatch();
  error CawonceUsed();
  error UserNotAuth();
  error TextTooLong();
  error NoWithdrawFee();
  error SignerMismatch();
  error SessionExpired();
  error MixedSenders();
  error NonContiguousCawonces();
  error OutOfScope();
  error SelfFollow();
  error SessionLimitExceeded();
  error UnknownOwner();
  error InvalidActionType();
  error BatchSigInvalid();
  error InvalidSig();
  error TooManyRecipients();
  error WithdrawZeroAmount();
  error InvalidValidator();
  error WrongProfileForSession(); // token-scoped session used for a different tokenId

  enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, OTHER }

  struct ActionData {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 receiverCawonce;
    uint32 networkId;
    uint32 cawonce;
    uint32[] recipients;
    uint64[] amounts;  // Whole CAW tokens (not wei) - multiplied by 10^18 on-chain
    bytes text;        // smltxt-compressed UTF-8 (decompressed by frontends/indexers)
  }

  bytes32 public immutable eip712DomainHash;

  // Checkpointing for verifiable migration to other chains (per-network)
  mapping(uint32 => uint256) public networkActionCount;
  mapping(uint32 => bytes32) public networkCurrentHash;
  mapping(uint32 => mapping(uint256 => bytes32)) public networkHashAtCheckpoint;

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  /// @notice Tracks cumulative spending (whole CAW tokens) per session key (by owner address)
  mapping(address => mapping(address => uint256)) public sessionSpent;

  /// @notice Pushed-ratio cap state. Packed into one 256-bit slot.
  ///         The oracle writes this via setCapRatio(); _getCost reads it with
  ///         a single SLOAD — zero external calls per action.
  struct CapState {
    uint64  lastUpdatedAt; // block.timestamp of last setCapRatio call
    uint192 ratio;         // 0 = cap dormant, baseline applies; else UQ112.112 ethPerCaw TWAP
  }
  CapState public capState;

  /// @notice Commitment to a processed batch. The full `packedActions` payload lives
  ///         in the originating tx's calldata (the same bytes passed to
  ///         processActions / safeProcessActions); indexers fetch it via
  ///         eth_getTransactionByHash and validate against `batchHash`.
  ///         `validatorId` is the submitting validator's profile id; `networkId`
  ///         is the per-batch single-network id (all actions in a batch share it).
  event ActionsProcessed(
    uint32 indexed networkId,
    uint32 indexed validatorId,
    uint16 actionCount,
    bytes32 batchHash
  );
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

  /// @notice Emitted whenever the cap oracle pushes a new ratio.
  ///         ratio == 0 means the cap is now dormant (baseline applies).
  event CapRatioUpdated(uint192 ratio, uint64 timestamp);

  CawProfileL2 public immutable cawProfile;
  CawActions public immutable externalSelf;

  /// @notice Sibling contract that handles variable-length ERC-1271 signatures
  ///         (passkey / smart-EOA owners). Set at construction via CREATE2
  ///         pre-image; immutable thereafter. Only this address may call
  ///         `executeVerifiedGroup`. Zero = ERC-1271 sibling path disabled.
  address public immutable erc1271Sibling;

  /// @notice Cap oracle for ETH-denominated per-action cost ceilings.
  ///         If address(0), all actions are charged the manifesto baseline
  ///         (backward-compatible null-oracle fallback, parallel to zkVerifier).
  ICawCapOracle public immutable capOracle;

  // Precomputed type hashes for EIP712
  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
    "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
  );
  /// @dev Typed-data hash for batched-action signatures. One signature over a
  ///      group of actions, all sharing the same senderId. The hash chain on
  ///      the source chain still commits per-action (using the batch sig's r),
  ///      so replication and the archive remain unchanged.
  bytes32 private constant ACTIONBATCH_TYPEHASH = keccak256(
    "ActionBatch(uint32 senderId,uint32 firstCawonce,uint32 actionCount,bytes32 actionsHash)"
  );

  /// @dev Checkpoint interval — a checkpoint is stored every N actions per network.
  /// @dev 32 actions per checkpoint. Small checkpoints enable flexible multibatch
  ///      replication: the validator packs consecutive checkpoints into one LZ
  ///      message up to the ~60KB limit. Worst case (32 actions, 420B text,
  ///      10 recipients) = ~18KB — always fits. Typical case (50B text) =
  ///      ~2.4KB — pack ~25 checkpoints (800 actions) per LZ message.
  ///      Checkpoint SSTORE cost is ~690 gas/action — negligible on L2.
  uint256 private constant CHECKPOINT_INTERVAL = 32;

  /// @dev Gas stipend for ERC-1271 isValidSignature staticcall on the
  ///      contract-owner cold path. Bounded so a malicious contract owner
  ///      cannot drain a relaying validator with an expensive
  ///      isValidSignature implementation. 50k is generous for a normal
  ///      "lookup authorized address + nonce" implementation but tight
  ///      enough to cap pathological ones. Honest implementers should keep
  ///      isValidSignature well under this budget.
  uint256 private constant ERC1271_GAS_LIMIT = 50_000;
  bytes4  private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

  /// @dev If the cap oracle hasn't pushed a fresh ratio within this window,
  ///      treat the stored ratio as stale and fall back to baseline.
  ///      Mirrors CawCapOracle.STALE_THRESHOLD — both must stay in sync.
  uint64 private constant CAP_STALE_THRESHOLD = 24 hours;

  // ============================================
  // ZK SIG-RECOVERY PATH (immutable hooks)
  // ============================================

  /// @notice Address of Succinct's canonical SP1Verifier on this chain.
  ///         Set at construction; immutable thereafter — there is no
  ///         "set verifier" path. To use a different verifier, deploy a
  ///         brand-new CawActions sibling.
  ISP1Verifier public immutable zkVerifier;

  /// @notice The verifying key digest (bytes32) of the sig-recovery circuit.
  ///         Bound at deploy, immutable. Re-running `cargo run --bin vkey`
  ///         in solidity/zk/sig-recovery/script after a circuit change
  ///         produces the new digest — and changing the circuit means
  ///         deploying a new CawActions because this is immutable.
  bytes32 public immutable zkProgramVKey;

  /// @notice Emitted once per `processActionsWithZkSigs` call. The bitmap
  ///         marks which slots in the supplied batch actually executed
  ///         (skip-don't-revert on cawonce conflicts: bit i = 0 means
  ///         action i was skipped because its cawonce was already used).
  ///         Indexers reconstructing the chain need this to know which
  ///         slice of the calldata to re-derive state from.
  event ActionsProcessedZk(
    uint32 indexed networkId,
    uint32 indexed validatorId,
    uint16 actionCount,
    uint256 actionsExecutedBitmap,
    bytes32 batchHash
  );

  constructor(address _cawProfiles, address _zkVerifier, bytes32 _zkProgramVKey, address _erc1271Sibling, address _capOracle) {
    eip712DomainHash = generateDomainHash();
    externalSelf = CawActions(this);
    cawProfile = CawProfileL2(_cawProfiles);
    zkVerifier = ISP1Verifier(_zkVerifier);
    zkProgramVKey = _zkProgramVKey;
    erc1271Sibling = _erc1271Sibling;
    capOracle = ICawCapOracle(_capOracle); // address(0) = cap dormant (backward-compatible)
  }

  // ============================================
  // PACKED FORMAT ENTRY POINTS
  // ============================================
  //
  // Packed calldata layout:
  //   packedActions:
  //     [2 bytes] uint16 actionCount
  //     Per action (variable):
  //       [1]   uint8   actionType
  //       [4]   uint32  senderId
  //       [4]   uint32  receiverId
  //       [4]   uint32  receiverCawonce
  //       [4]   uint32  networkId
  //       [4]   uint32  cawonce
  //       [1]   uint8   recipientCount (N)
  //       [1]   uint8   amountCount (M) — as signed (0, N, or N+1)
  //       [4*N] uint32  recipients
  //       [8*M] uint64  amounts
  //       [2]   uint16  textLength (T)
  //       [T]   bytes   text
  //
  //   sigs: grouped signatures
  //     [2 bytes] uint16 numGroups
  //     Per group:
  //       [2]   uint16  groupSize  (1 = single sig, 2+ = batch sig over groupSize actions)
  //       [1]   uint8   v
  //       [32]  bytes32 r
  //       [32]  bytes32 s
  //     Each group's signature is verified ONCE; for a batch group the signed
  //     payload is an ActionBatch typed struct over the group's contiguous
  //     actions. All actions in a batch group must share senderId.

  /// @notice Process a batch of actions from packed calldata. ~50% less gas than
  ///         the ABI-encoded version because calldata is ~60% smaller. Supports
  ///         per-action sigs (group of 1) and batched sigs (one sig over many
  ///         actions from the same sender) in any mix within the same call.
  function processActions(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable {
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
    if (actionCount == 0) revert NoActions();
    if (actionCount > 256) revert TooManyActions();

    uint256 numGroups;
    assembly { numGroups := shr(240, calldataload(sigs.offset)) }
    if (numGroups == 0 || numGroups > actionCount) revert BadSigGroupCount();

    BatchCursor memory c;
    c.pos = 2;     // skip actionCount header
    c.sigPos = 2;  // skip numGroups header

    for (uint256 g = 0; g < numGroups; ) {
      _processOneGroup(validatorId, packedActions, sigs, c, actionCount);
      unchecked { ++g; }
    }

    if (c.actionsSeen != actionCount) revert SigsIncomplete();
    // Reject trailing bytes after the consumed actions. Without this, two
    // semantically-identical batches with different trailing-byte content
    // emit different `batchHash` fields, confusing indexers that dedupe by
    // batchHash. Audit fix 2026-05-08 (Round 3 CawActions adversarial agent).
    if (c.pos != packedActions.length) revert TrailingBytes();

    // Flush the in-memory hash chain back to storage — one SSTORE pair
    // total instead of one per action. networkHashLoaded is the latch:
    // false means no actions were applied (impossible past the actionCount
    // > 0 check above, but defensive against future refactors).
    if (c.networkHashLoaded) {
      networkCurrentHash[c.firstNetworkId] = c.networkHash;
      networkActionCount[c.firstNetworkId] = c.networkActionCount;
    }

    // Credit the validator with the sum of implicit per-action session tips
    // accumulated across the batch. One SSTORE total instead of one per
    // session-key action — the meaningful gas-saving leg of the empty-amounts
    // optimization. Manual-sign and explicit-tip actions credited inline via
    // _distributeAmountsMem and don't contribute here.
    if (c.implicitTipOwed > 0) {
      // Validate validatorId here too: the empty-recipients fast path in
      // _distributeAmountsMem skips the ownerOf check that the recipient
      // path enforces. Without this, an FE bug submitting a stale/wrong
      // validatorId silently burns the tip into a no-owner cawOwnership
      // slot. Audit fix 2026-05-08 (Round 4 CawActions LOW-1).
      _requireValidatorExists(validatorId);
      cawProfile.addTokensToBalance(validatorId, c.implicitTipOwed);
    }

    emit ActionsProcessed(
      c.firstNetworkId,
      validatorId,
      uint16(actionCount),
      keccak256(packedActions)
    );

    if (c.withdrawCount > 0) {
      _handleWithdrawals(c.withdrawBitmap, c.withdrawCount, actionCount, packedActions);
      // bypassLZ mode legitimately needs zero LZ fee but still requires
      // the L1 credit to fire. LZ mode requires a non-zero fee for the
      // cross-chain message. A zero fee in non-bypassLZ mode would skip
      // _executeWithdrawals after the L2 debit already ran — silent fund
      // loss. Revert instead so a misconfigured validator surfaces. Audit
      // fix 2026-05-08 (C-1; tightened in Round 3).
      if (withdrawFee == 0 && !cawProfile.bypassLZ()) revert NoWithdrawFee();
      _executeWithdrawals(withdrawFee, withdrawLzTokenAmount);
    }
  }

  /// @notice Process a batch of actions using a ZK proof of signature recovery
  ///         instead of on-chain ecrecover per action.
  ///
  /// @dev    The proof attests "I correctly recovered the signers of every
  ///         action — they are the addresses committed to by signersHash."
  ///         The proof DOES NOT commit to chain state (cawonces, balances,
  ///         hash chain), so it's race-safe: a competing tx between proof
  ///         generation and submission only causes the affected slots to be
  ///         skipped, not the whole batch to be lost.
  ///
  ///         Two contracts of difference vs `processActions`:
  ///         1. Per-action ecrecover is replaced with one constant-cost
  ///            verifier call (~250K gas) plus a 20-byte read from `signers`
  ///            for each action.
  ///         2. Cawonce conflicts SKIP rather than REVERT — see the
  ///            ActionsProcessedZk event's `actionsExecutedBitmap` for which
  ///            slots actually ran. The sig path keeps the all-or-nothing
  ///            semantic so existing simulate/estimate flows aren't broken.
  ///
  /// @param  validatorId           Submitting validator's profile id
  /// @param  packedActions         Same byte layout as `processActions`
  /// @param  packedSigs            Same byte layout — the proof commits to
  ///                               keccak256(packedSigs), and the contract
  ///                               still walks groups to read each group's
  ///                               r value (used as the hash-chain anchor)
  /// @param  signers               Concatenated 20-byte signer addresses,
  ///                               one per action position. The proof commits
  ///                               to keccak256(signers) so this can't be
  ///                               substituted post-prove.
  /// @param  proof                 Groth16 proof bytes from SP1
  function processActionsWithZkSigs(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata packedSigs,
    bytes calldata signers,
    bytes calldata proof,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable {
    if (address(zkVerifier) == address(0)) revert ZkNotConfigured();

    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
    if (actionCount == 0) revert NoActions();
    if (actionCount > 256) revert TooManyActions();
    if (signers.length != actionCount * 20) revert ZkSignersMismatch();

    // Verify the proof. The verifier reverts on failure; on success the
    // proof has attested:
    //   keccak256(packedActions) == public_input[0]
    //   keccak256(packedSigs)    == public_input[1]
    //   keccak256(signers)       == public_input[2]
    //   eip712DomainHash         == public_input[3]
    // packedActionsHash is reused at event-emit time below — caching saves
    // ~6 gas/byte of packedActions (one redundant keccak avoided).
    bytes32 packedActionsHash = keccak256(packedActions);
    bytes memory publicValues = abi.encode(
      packedActionsHash,
      keccak256(packedSigs),
      keccak256(signers),
      eip712DomainHash
    );
    zkVerifier.verifyProof(zkProgramVKey, publicValues, proof);

    // Walk groups to track per-group state (the r anchor for the hash chain
    // is the same r the prover signed against, which we read from packedSigs;
    // the proof guarantees signers[i] is the correct recovered address).
    BatchCursor memory c;
    c.pos = 2;
    c.sigPos = 2;

    uint256 numGroups;
    assembly { numGroups := shr(240, calldataload(packedSigs.offset)) }
    if (numGroups == 0 || numGroups > actionCount) revert BadSigGroupCount();

    uint256 actionsExecutedBitmap;

    for (uint256 g = 0; g < numGroups; ) {
      actionsExecutedBitmap = _zkProcessOneGroup(
        validatorId, packedActions, packedSigs, signers, c, actionCount, actionsExecutedBitmap
      );
      unchecked { ++g; }
    }

    if (c.actionsSeen != actionCount) revert SigsIncomplete();
    // See processActions for the trailing-bytes rationale.
    if (c.pos != packedActions.length) revert TrailingBytes();

    if (c.networkHashLoaded) {
      networkCurrentHash[c.firstNetworkId] = c.networkHash;
      networkActionCount[c.firstNetworkId] = c.networkActionCount;
    }
    if (c.implicitTipOwed > 0) {
      // See processActions for the validatorId rationale.
      _requireValidatorExists(validatorId);
      cawProfile.addTokensToBalance(validatorId, c.implicitTipOwed);
    }

    emit ActionsProcessedZk(
      c.firstNetworkId,
      validatorId,
      uint16(actionCount),
      actionsExecutedBitmap,
      packedActionsHash
    );

    if (c.withdrawCount > 0) {
      _handleWithdrawals(c.withdrawBitmap, c.withdrawCount, actionCount, packedActions);
      // See processActions for the bypassLZ rationale.
      if (withdrawFee == 0 && !cawProfile.bypassLZ()) revert NoWithdrawFee();
      _executeWithdrawals(withdrawFee, withdrawLzTokenAmount);
    }
  }

  /// @dev ZK-path equivalent of _processOneGroup. Reads (groupSize, v, r, s)
  ///      from packedSigs like the sig path does, but trusts the verified
  ///      `signers` array instead of running ecrecover. Returns the updated
  ///      executed-bitmap (bit i set = action i ran).
  function _zkProcessOneGroup(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata packedSigs,
    bytes calldata signers,
    BatchCursor memory c,
    uint256 actionCount,
    uint256 executedBitmap
  ) internal returns (uint256) {
    (uint256 groupSize, , bytes32 r, ) = _readSigGroup(packedSigs, c.sigPos);
    if (groupSize == 0) revert EmptyGroup();
    if (c.actionsSeen + groupSize > actionCount) revert GroupOverflows();
    c.sigPos += 67;

    // Read the verified signer for the FIRST action in this group. Within
    // a sig group every action shares one signer (single-sig group: 1
    // action = 1 signer; batch-sig group: N actions all signed once), and
    // the prover's signers[] array reflects that — same address repeated
    // groupSize times. We read once and reuse, but we ALSO require the
    // remaining slots in signers to match the first (so a malicious prover
    // can't slip a different signer onto a batched action).
    address signer = _readSigner(signers, c.actionsSeen);
    for (uint256 i = 1; i < groupSize; ) {
      if (_readSigner(signers, c.actionsSeen + i) != signer) revert SignerMismatch();
      unchecked { ++i; }
    }

    // For session keys vs owner: same logic as _verifySignatureMem, just
    // without the ecrecover (the proof gave us `signer` directly).
    //
    // The ZK path does NOT support ERC-1271 / contract-owned profiles. The
    // proof commits to the EOA-recovered signer; for a Safe-owned profile
    // there's no EOA to recover. Validators MUST route those batches through
    // processActions instead. The non-owner branch below requires a valid
    // session record OR reverts — there's no 1271 fallback, by design.
    BatchAuth memory ba;
    ba.signer = signer;
    ba.r = r;
    uint32 senderId0 = _peekSenderId(packedActions, c.pos);
    address owner = cawProfile.ownerOf(senderId0);
    if (signer == owner) {
      ba.isSessionKey = false;
    } else {
      // Session-key path: load the full session record from storage and
      // re-validate expiry on-chain. The proof attests "this address signed
      // these actions" — it does NOT attest that the address is currently
      // an authorized session key. Without an explicit expiry check here,
      // an expired or revoked session would still authorize actions in the
      // ZK path. (Audit finding 2026-05-08, Issue B.)
      CawProfileL2.StoredSession memory s = cawProfile.validSession(owner, signer);
      if (s.expiry <= block.timestamp) revert SessionExpired();
      if (s.profileId != 0 && s.profileId != senderId0) revert WrongProfileForSession();
      ba.isSessionKey = true;
      ba.owner = owner;
      ba.scopeBitmap = s.scopeBitmap;
      ba.spendLimit = s.spendLimit;
      ba.perActionTipRate = s.perActionTipRate;
    }

    // Apply each action with skip-don't-revert on cawonce conflicts.
    for (uint256 i = 0; i < groupSize; ) {
      executedBitmap = _zkApplyOne(validatorId, packedActions, c, ba, senderId0, executedBitmap);
      unchecked { ++i; }
    }

    if (ba.groupSpentLoaded) sessionSpent[ba.owner][ba.signer] = ba.groupSpent;
    return executedBitmap;
  }

  /// @dev Single-action arm of the ZK group walk. Split out of the main loop
  ///      to keep the via-IR optimizer's stack shallow enough.
  ///
  ///      Skip-don't-revert semantics: if the cawonce was consumed between
  ///      proof generation and submission, we DROP the slot entirely — no
  ///      `withdrawBitmap` bit set (so no L1 `setWithdrawable` for a WITHDRAW
  ///      that didn't debit on L2), no `implicitTipOwed` credit (validator
  ///      gets nothing for skipped work), no `networkHash` extension (that
  ///      lives inside `_applyAction`). Only the cursor advances.
  function _zkApplyOne(
    uint32 validatorId,
    bytes calldata packedActions,
    BatchCursor memory c,
    BatchAuth memory ba,
    uint32 senderId0,
    uint256 executedBitmap
  ) internal returns (uint256) {
    uint256 actionStart = c.pos;
    (ActionData memory action, uint256 nextPos) = _unpackAction(packedActions, c.pos);
    c.pos = nextPos;

    // Network-id invariant must hold across the whole batch even if some
    // actions are skipped. firstNetworkId is set on the very first action
    // (index 0) and every subsequent action must match it.
    if (c.actionsSeen == 0) {
      c.firstNetworkId = action.networkId;
    } else {
      if (action.networkId != c.firstNetworkId) revert MixedNetworks();
    }

    // Mixed-sender guard: defense-in-depth against a broken/malicious ZK
    // circuit attesting a single signer for actions on different senderIds.
    // The sig path enforces this via `Mixed senders in batch` in _unpackBatchGroup;
    // the ZK path must mirror it. Without this, a faulty proof could authorize
    // actions on any senderId by smuggling them into a group keyed to a different
    // owner. (Audit 2026-05-17, H-2.)
    if (action.senderId != senderId0) revert MixedSenders();

    // Race-loss check.
    if (isCawonceUsed(action.senderId, action.cawonce)) {
      unchecked { ++c.actionsSeen; }
      return executedBitmap;
    }

    // Action is going to execute. NOW we mark it as a withdraw if applicable
    // — this matches the sig path's invariant that withdrawBitmap only
    // contains EXECUTED WITHDRAWs.
    if (action.actionType == ActionType.WITHDRAW) {
      c.withdrawBitmap |= (1 << c.actionsSeen);
      unchecked { ++c.withdrawCount; }
    }

    // Session scope check (session-key signers only).
    if (ba.isSessionKey) {
      if ((ba.scopeBitmap & (1 << uint8(action.actionType))) == 0) revert OutOfScope();
    }

    // Capture implicitTipOwed exactly like the sig path does in
    // _processSingleSig. Without this the validator runs the tx but never
    // gets credited the per-action session tip.
    c.implicitTipOwed += _applyAction(validatorId, action, ba, packedActions[actionStart:nextPos], c);
    executedBitmap |= (1 << c.actionsSeen);
    unchecked { ++c.actionsSeen; }
    return executedBitmap;
  }

  /// @dev Read the 20-byte signer at index `idx` from the concat'd `signers` blob.
  function _readSigner(bytes calldata signers, uint256 idx) internal pure returns (address signer) {
    assembly {
      // address occupies the high 20 bytes of a 32-byte word; load 32, shift right 96.
      signer := shr(96, calldataload(add(signers.offset, mul(idx, 20))))
    }
  }

  /// @dev Read just the senderId (4 bytes at offset+1) of the action at `packedActions[pos:]`.
  ///      Used to look up the owner for session-key resolution before fully unpacking.
  function _peekSenderId(bytes calldata packedActions, uint256 pos) internal pure returns (uint32 senderId) {
    assembly {
      // calldataload reads 32 bytes; pos+1 lands on senderId's first byte;
      // senderId occupies bytes [0..4) of the loaded word, so shift right
      // by 28 bytes (224 bits) to land it in the low 32 bits.
      senderId := and(shr(224, calldataload(add(packedActions.offset, add(pos, 1)))), 0xFFFFFFFF)
    }
  }

  /// @dev Bookkeeping passed through the group-processing loop by reference.
  ///      Avoids returning a 6-tuple from internal helpers.
  ///
  ///      `networkHash` / `networkActionCount` are the in-memory hash-chain
  ///      accumulators. We load `networkCurrentHash[firstNetworkId]` and
  ///      `networkActionCount[firstNetworkId]` lazily on the first action,
  ///      mutate them per action in memory, and write back once at the end
  ///      of the batch — replacing N SLOAD/SSTORE pairs with one of each.
  ///      `networkHashLoaded` is the lazy-load latch.
  struct BatchCursor {
    uint256 pos;             // current offset into packedActions
    uint256 sigPos;          // current offset into sigs
    uint256 actionsSeen;     // total actions processed so far across all groups
    uint32  firstNetworkId;   // set on first action; enforced equal across all
    uint16  withdrawCount;
    uint256 withdrawBitmap;
    uint256 implicitTipOwed; // sum of session-key per-action tips, credited once at batch end
    bytes32 networkHash;          // in-memory mirror of networkCurrentHash[firstNetworkId]
    uint256 networkActionCount;   // in-memory mirror of networkActionCount[firstNetworkId]
    bool    networkHashLoaded;    // false until first action loads from storage
  }

  /// @dev Read a sig group header from `sigs` at `sigPos` and advance.
  ///      Layout: [2 groupSize][1 v][32 r][32 s] = 67 bytes.
  function _readSigGroup(bytes calldata sigs, uint256 sigPos)
    internal pure returns (uint256 groupSize, uint8 v, bytes32 r, bytes32 s)
  {
    assembly {
      let off := add(sigs.offset, sigPos)
      groupSize := shr(240, calldataload(off))
      v := shr(248, calldataload(add(off, 2)))
      r := calldataload(add(off, 3))
      s := calldataload(add(off, 35))
    }
  }

  /// @dev Validate group size: non-zero and doesn't overflow the batch. Pure
  ///      helper extracted to keep _processOneGroup's Yul stack within the
  ///      via-IR scheduler's 16-slot limit (the inline guards push it 1 over).
  function _checkGroupBounds(uint256 groupSize, uint256 actionsSeen, uint256 actionCount) private pure {
    if (groupSize == 0) revert EmptyGroup();
    if (actionsSeen + groupSize > actionCount) revert GroupOverflows();
  }

  /// @dev Process one signature group: recover the signer once, apply each
  ///      action in the group with the same r anchor in the hash chain.
  function _processOneGroup(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    BatchCursor memory c,
    uint256 actionCount
  ) internal {
    (uint256 groupSize, uint8 v, bytes32 r, bytes32 s) = _readSigGroup(sigs, c.sigPos);
    _checkGroupBounds(groupSize, c.actionsSeen, actionCount);
    c.sigPos += 67;

    if (groupSize == 1) {
      _processSingleSig(validatorId, packedActions, c, v, r, s);
    } else {
      _processBatchSig(validatorId, packedActions, c, groupSize, v, r, s);
    }
  }

  /// @dev Single-action sig path within a group of size 1. Backwards-compatible
  ///      with the legacy per-action sig flow.
  function _processSingleSig(
    uint32 validatorId,
    bytes calldata packedActions,
    BatchCursor memory c,
    uint8 v, bytes32 r, bytes32 s
  ) internal {
    uint256 actionStart = c.pos;
    (ActionData memory action, uint256 nextPos) = _unpackAction(packedActions, c.pos);
    c.pos = nextPos;
    _trackNetworkAndWithdraw(c, action, c.actionsSeen);
    (address signer, bool isSessionKey) = _verifySignatureMem(v, r, s, action);
    BatchAuth memory ba;
    ba.signer = signer;
    ba.isSessionKey = isSessionKey;
    ba.r = r;
    if (isSessionKey) {
      ba.owner = cawProfile.ownerOf(action.senderId);
      { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.scopeBitmap = _s.scopeBitmap; ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != action.senderId) revert WrongProfileForSession(); }
    }
    c.implicitTipOwed += _applyAction(validatorId, action, ba, packedActions[actionStart:nextPos], c);
    c.actionsSeen += 1;

    // Flush single-sig group's sessionSpent. Same shape as the batch-sig
    // flush in _applyBatch — keeping them parallel even for groupSize==1
    // (where there's nothing to amortize) avoids a special case.
    if (ba.groupSpentLoaded) sessionSpent[ba.owner][ba.signer] = ba.groupSpent;
  }

  /// @dev Batch-sig path: one signature over ACTIONBATCH_TYPEHASH covering
  ///      `groupSize` consecutive actions from the same senderId.
  function _processBatchSig(
    uint32 validatorId,
    bytes calldata packedActions,
    BatchCursor memory c,
    uint256 groupSize,
    uint8 v, bytes32 r, bytes32 s
  ) internal {
    bytes32[] memory perActionHashes = new bytes32[](groupSize);
    ActionData[] memory groupActions = new ActionData[](groupSize);
    uint256[] memory sliceStarts = new uint256[](groupSize);
    uint256[] memory sliceEnds = new uint256[](groupSize);

    _unpackBatchGroup(packedActions, c, groupSize, perActionHashes, groupActions, sliceStarts, sliceEnds);

    BatchAuth memory ba;
    (ba.signer, ba.isSessionKey) = _verifyBatchSignature(
      v, r, s,
      groupActions[0].senderId,
      groupActions[0].cawonce,
      uint32(groupSize),
      keccak256(abi.encodePacked(perActionHashes))
    );
    ba.r = r;
    if (ba.isSessionKey) {
      ba.owner = cawProfile.ownerOf(groupActions[0].senderId);
      { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.scopeBitmap = _s.scopeBitmap; ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != groupActions[0].senderId) revert WrongProfileForSession(); }
    }

    _applyBatch(validatorId, packedActions, groupActions, sliceStarts, sliceEnds, ba, c);
    c.actionsSeen += groupSize;
  }

  /// @dev Walk `groupSize` actions starting at `c.pos`, unpacking each one,
  ///      tracking network/withdraw bookkeeping, and asserting the batch
  ///      invariants (same sender, contiguous cawonces). Splits the per-batch
  ///      preamble out of _processBatchSig to keep that function's stack
  ///      shallow enough for the via-IR optimizer.
  function _unpackBatchGroup(
    bytes calldata packedActions,
    BatchCursor memory c,
    uint256 groupSize,
    bytes32[] memory perActionHashes,
    ActionData[] memory groupActions,
    uint256[] memory sliceStarts,
    uint256[] memory sliceEnds
  ) internal pure {
    for (uint256 i = 0; i < groupSize; ) {
      uint256 sliceStart = c.pos;
      (ActionData memory action, uint256 nextPos) = _unpackAction(packedActions, c.pos);
      c.pos = nextPos;

      _trackNetworkAndWithdraw(c, action, c.actionsSeen + i);

      // All actions in a batch must share the same senderId. Without this,
      // one user's batch sig could authorize another user's actions.
      // Cawonces must be strictly contiguous and ascending — without this
      // check, `firstCawonce` in ACTIONBATCH_TYPEHASH would be redundant
      // with `actionsHash` and a future tightening could silently change
      // the signed semantics.
      if (i > 0) {
        if (action.senderId != groupActions[0].senderId) revert MixedSenders();
        if (action.cawonce != groupActions[0].cawonce + i) revert NonContiguousCawonces();
      }

      groupActions[i] = action;
      sliceStarts[i] = sliceStart;
      sliceEnds[i] = nextPos;
      perActionHashes[i] = keccak256(packedActions[sliceStart:nextPos]);
      unchecked { ++i; }
    }
  }

  /// @dev Walk `groupSize` actions from the start of `groupBytes` (a slice
  ///      with no batch header), unpacking each one and asserting that all
  ///      actions share the same networkId. Parallel to `_unpackBatchGroup`
  ///      but used by `processGroupSingle` — split out to keep that
  ///      function's stack shallow enough for the via-IR optimizer on
  ///      newer Solidity (the inline version blows the stack on 0.8.30
  ///      with eight memory pointers + counters + the firstNetworkId local).
  function _unpackProcessGroup(
    bytes calldata groupBytes,
    uint256 groupSize,
    bytes32[] memory perActionHashes,
    ActionData[] memory groupActions,
    uint256[] memory sliceStarts,
    uint256[] memory sliceEnds
  ) internal pure returns (uint32 firstNetworkId) {
    uint256 pos = 0;
    for (uint256 i = 0; i < groupSize; ) {
      uint256 sliceStart = pos;
      (ActionData memory action, uint256 nextPos) = _unpackAction(groupBytes, pos);
      pos = nextPos;
      if (i == 0) firstNetworkId = action.networkId;
      else if (action.networkId != firstNetworkId) revert MixedNetworks();
      groupActions[i] = action;
      sliceStarts[i] = sliceStart;
      sliceEnds[i] = nextPos;
      perActionHashes[i] = keccak256(groupBytes[sliceStart:nextPos]);
      unchecked { ++i; }
    }
  }

  /// @dev Bundle of fields produced by batch-sig recovery, threaded into
  ///      _applyBatch as one struct to keep the inner loop's stack shallow.
  ///      `owner` and `spendLimit` are populated once at sig recovery (when
  ///      the signer is a session key) and reused for every action in the
  ///      group, eliminating an N-fold cawProfile.sessions(...) re-fetch.
  struct BatchAuth {
    address signer;
    bool    isSessionKey;
    uint8   scopeBitmap;
    bytes32 r;
    address owner;             // cawProfile.ownerOf(senderId), only when isSessionKey
    uint256 spendLimit;        // session.spendLimit, only when isSessionKey
    uint64  perActionTipRate;  // implicit validator tip per action, only when isSessionKey
    /// In-memory accumulator for sessionSpent[owner][signer] over the lifetime
    /// of a sig group. Lazy-loaded from storage on the first cost-bearing
    /// session action; flushed once at group end (one SSTORE per group instead
    /// of one per action). `_groupSpentLoaded` is the lazy-load latch.
    uint256 groupSpent;
    bool    groupSpentLoaded;
  }

  /// @dev Apply each action in a verified batch group, doing the per-action
  ///      session-scope check before _applyAction. Threads the cached
  ///      session (owner, spendLimit) into _applyAction so the inner loop
  ///      doesn't re-read cawProfile.sessions(...) per action.
  function _applyBatch(
    uint32 validatorId,
    bytes calldata packedActions,
    ActionData[] memory groupActions,
    uint256[] memory sliceStarts,
    uint256[] memory sliceEnds,
    BatchAuth memory ba,
    BatchCursor memory c
  ) internal {
    uint256 n = groupActions.length;
    uint256 owed;
    for (uint256 i = 0; i < n; ) {
      ActionData memory action = groupActions[i];
      if (ba.isSessionKey) {
        if ((ba.scopeBitmap & (1 << uint8(action.actionType))) == 0) revert OutOfScope();
      }
      owed += _applyAction(validatorId, action, ba, packedActions[sliceStarts[i]:sliceEnds[i]], c);
      unchecked { ++i; }
    }
    c.implicitTipOwed += owed;

    // Flush per-group sessionSpent. (owner, signer) is constant within a
    // sig group, so one SSTORE replaces N. Lazy-loaded inside _applyAction
    // on the first cost-bearing action.
    if (ba.groupSpentLoaded) sessionSpent[ba.owner][ba.signer] = ba.groupSpent;
  }

  /// @dev Single-network invariant + withdraw bookkeeping per action.
  function _trackNetworkAndWithdraw(BatchCursor memory c, ActionData memory action, uint256 actionIndex) internal pure {
    if (actionIndex == 0) {
      c.firstNetworkId = action.networkId;
    } else {
      if (action.networkId != c.firstNetworkId) revert MixedNetworks();
    }
    if (action.actionType == ActionType.WITHDRAW) {
      c.withdrawBitmap |= (1 << actionIndex);
      unchecked { ++c.withdrawCount; }
    }
  }

  /// @notice Safe version — tries each sig group individually, collects rejections.
  ///         Intended for eth_call simulation before submitting via processActions.
  ///         All-or-nothing per group: if a batch group fails, every action in
  ///         that group is marked rejected with the same reason.
  function safeProcessActions(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable returns (uint256 successCount, string[] memory rejections) {
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
    if (actionCount == 0) revert NoActions();
    if (actionCount > 256) revert TooManyActions();

    uint256 numGroups;
    assembly { numGroups := shr(240, calldataload(sigs.offset)) }
    if (numGroups == 0 || numGroups > actionCount) revert BadSigGroupCount();

    rejections = new string[](actionCount);
    SafeCursor memory sc;
    sc.pos = 2;     // skip actionCount header
    sc.sigPos = 2;  // skip numGroups header

    for (uint256 g = 0; g < numGroups; ) {
      _safeProcessOneGroup(validatorId, packedActions, sigs, sc, rejections, actionCount);
      unchecked { ++g; }
    }

    if (sc.actionsSeen != actionCount) revert SigsIncomplete();
    // See processActions for the trailing-bytes rationale.
    if (sc.pos != packedActions.length) revert TrailingBytes();
    successCount = sc.successCount;

    // NOTE (audited 2026-04-20): the calldata referenced by `batchHash` is the
    // FULL packedActions including rejected actions, not just the successful
    // ones. Indexers MUST cross-reference ActionRejected events to filter.
    if (successCount > 0) {
      emit ActionsProcessed(
        sc.firstNetworkId,
        validatorId,
        uint16(actionCount),
        keccak256(packedActions)
      );
    }

    // Mirror processActions: _handleWithdrawals always runs when there are
    // withdraws so the per-action withdraw bookkeeping isn't lost; the
    // _executeWithdrawals call requires either a positive LZ fee or the
    // bypassLZ co-deployment shortcut.
    if (sc.withdrawCount > 0) {
      _handleWithdrawals(sc.withdrawBitmap, sc.withdrawCount, actionCount, packedActions);
      // See processActions for the bypassLZ rationale.
      if (withdrawFee == 0 && !cawProfile.bypassLZ()) revert NoWithdrawFee();
      _executeWithdrawals(withdrawFee, withdrawLzTokenAmount);
    }
  }

  /// @dev Bookkeeping for safeProcessActions, kept on the stack as a struct
  ///      to dodge "stack too deep" inside the per-group inner loop.
  struct SafeCursor {
    uint256 pos;
    uint256 sigPos;
    uint256 actionsSeen;
    uint256 successCount;
    uint16  withdrawCount;
    uint256 withdrawBitmap;
    uint32  firstNetworkId;   // captured from the first action; used for the ActionsProcessed event
  }

  /// @dev Process one sig group in the safe path: try the whole group via
  ///      the external trampoline, all-or-nothing. Updates the cursor in place.
  function _safeProcessOneGroup(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    SafeCursor memory sc,
    string[] memory rejections,
    uint256 actionCount
  ) internal {
    (uint256 groupSize, uint8 v, bytes32 r, bytes32 s) = _readSigGroup(sigs, sc.sigPos);
    _checkGroupBounds(groupSize, sc.actionsSeen, actionCount);
    sc.sigPos += 67;

    uint256 groupStartPos = sc.pos;

    // Walk slices once to capture metadata for rejection labelling +
    // withdraw tracking, and to advance pos to the end of the group.
    uint32[] memory senderIds = new uint32[](groupSize);
    uint32[] memory cawonces = new uint32[](groupSize);
    bool[] memory isWithdraw = new bool[](groupSize);
    for (uint256 i = 0; i < groupSize; ) {
      (ActionData memory peek, uint256 nextPos) = _unpackAction(packedActions, sc.pos);
      sc.pos = nextPos;
      senderIds[i] = peek.senderId;
      cawonces[i] = peek.cawonce;
      isWithdraw[i] = peek.actionType == ActionType.WITHDRAW;
      // Capture networkId once from the very first action of the very first group.
      // Subsequent groups must match (enforced by _trackNetworkAndWithdraw inside
      // processGroupSingle's success path; safe-mode failures don't emit).
      if (sc.actionsSeen == 0 && i == 0) {
        sc.firstNetworkId = peek.networkId;
      }
      unchecked { ++i; }
    }

    try CawActions(this).processGroupSingle(
      validatorId, packedActions[groupStartPos:sc.pos], v, r, s, uint16(groupSize), address(0)
    ) {
      sc.successCount += groupSize;
      for (uint256 i = 0; i < groupSize; ) {
        if (isWithdraw[i]) {
          sc.withdrawBitmap |= (1 << (sc.actionsSeen + i));
          unchecked { ++sc.withdrawCount; }
        }
        unchecked { ++i; }
      }
    } catch Error(string memory reason) {
      for (uint256 i = 0; i < groupSize; ) {
        rejections[sc.actionsSeen + i] = reason;
        emit ActionRejected(senderIds[i], cawonces[i], reason);
        unchecked { ++i; }
      }
    } catch (bytes memory) {
      for (uint256 i = 0; i < groupSize; ) {
        rejections[sc.actionsSeen + i] = "Low-level exception";
        emit ActionRejected(senderIds[i], cawonces[i], "Low-level exception");
        unchecked { ++i; }
      }
    }

    sc.actionsSeen += groupSize;
  }

  /// @notice External entry for safeProcessActions try/catch, and (with a
  ///         pre-verified signer) for the ERC-1271 sibling path.
  ///
  ///         Normal mode (preVerifiedSigner == address(0)):
  ///           Callable only by `address(this)` (self-call from safeProcessActions).
  ///           Performs full ECDSA / ERC-1271 sig verification.
  ///
  ///         Sibling mode (preVerifiedSigner != address(0)):
  ///           Callable only by `erc1271Sibling`. Skips sig verification —
  ///           the sibling has already called `isValidSignature` on the owner.
  ///           `v`, `s` are ignored; `r` is the hash-chain anchor
  ///           (= keccak256(sigBlob), spec-locked per project_replication_wire_format).
  function processGroupSingle(
    uint32 validatorId,
    bytes calldata groupBytes,
    uint8 v, bytes32 r, bytes32 s,
    uint16 groupSize,
    address preVerifiedSigner
  ) external {
    if (preVerifiedSigner != address(0)) {
      if (msg.sender != erc1271Sibling) revert NotSibling();
    } else {
      if (msg.sender != address(this)) revert OnlySelf();
    }

    bytes32[] memory perActionHashes = new bytes32[](groupSize);
    ActionData[] memory groupActions = new ActionData[](groupSize);
    uint256[] memory sliceStarts = new uint256[](groupSize);
    uint256[] memory sliceEnds = new uint256[](groupSize);

    uint32 firstNetworkId = _unpackProcessGroup(groupBytes, groupSize, perActionHashes, groupActions, sliceStarts, sliceEnds);

    BatchAuth memory ba;
    ba.r = r;

    if (preVerifiedSigner != address(0)) {
      ba.signer = preVerifiedSigner;
      ba.isSessionKey = false;
    } else if (groupSize == 1) {
      (ba.signer, ba.isSessionKey) = _verifySignatureMem(v, r, s, groupActions[0]);
      if (ba.isSessionKey) {
        ba.owner = cawProfile.ownerOf(groupActions[0].senderId);
        { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.scopeBitmap = _s.scopeBitmap; ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != groupActions[0].senderId) revert WrongProfileForSession(); }
      }
    } else {
      for (uint256 i = 1; i < groupSize; ) {
        if (groupActions[i].senderId != groupActions[0].senderId) revert MixedSenders();
        if (groupActions[i].cawonce != groupActions[0].cawonce + i) revert NonContiguousCawonces();
        unchecked { ++i; }
      }
      (ba.signer, ba.isSessionKey) = _verifyBatchSignature(
        v, r, s,
        groupActions[0].senderId,
        groupActions[0].cawonce,
        uint32(groupSize),
        keccak256(abi.encodePacked(perActionHashes))
      );
      if (ba.isSessionKey) {
        ba.owner = cawProfile.ownerOf(groupActions[0].senderId);
        { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.scopeBitmap = _s.scopeBitmap; ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != groupActions[0].senderId) revert WrongProfileForSession(); }
      }
    }

    BatchCursor memory localCursor;
    localCursor.firstNetworkId = firstNetworkId;
    _applyBatch(validatorId, groupBytes, groupActions, sliceStarts, sliceEnds, ba, localCursor);
    if (localCursor.networkHashLoaded) {
      networkCurrentHash[firstNetworkId] = localCursor.networkHash;
      networkActionCount[firstNetworkId] = localCursor.networkActionCount;
    }
    if (localCursor.implicitTipOwed > 0) {
      _requireValidatorExists(validatorId);
      cawProfile.addTokensToBalance(validatorId, localCursor.implicitTipOwed);
    }
  }

  /// @notice External entry for legacy single-sig path. Only callable by self.
  function processActionSingle(
    uint32 validatorId,
    ActionData calldata action,
    uint8 v, bytes32 r, bytes32 s,
    bytes calldata packedSlice
  ) external {
    if (msg.sender != address(this)) revert OnlySelf();
    _processActionPacked(validatorId, action, v, r, s, packedSlice);
  }

  // ============================================
  // CORE ACTION PROCESSING
  // ============================================

  /// @dev Verify a per-action signature (the legacy single-sig path) and
  ///      then apply the action. Kept as a thin wrapper so existing callers
  ///      (processActionSingle) don't need to change.
  function _processActionPacked(
    uint32 validatorId,
    ActionData memory action,
    uint8 v, bytes32 r, bytes32 s,
    bytes calldata packedSlice
  ) internal {
    (address signer, bool isSessionKey) = _verifySignatureMem(v, r, s, action);
    BatchAuth memory ba;
    ba.signer = signer;
    ba.isSessionKey = isSessionKey;
    ba.r = r;
    if (isSessionKey) {
      ba.owner = cawProfile.ownerOf(action.senderId);
      { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.scopeBitmap = _s.scopeBitmap; ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != action.senderId) revert WrongProfileForSession(); }
    }
    BatchCursor memory localCursor;
    localCursor.firstNetworkId = action.networkId;
    uint256 owed = _applyAction(validatorId, action, ba, packedSlice, localCursor);
    // Single-action external entry: flush back immediately (no batch to
    // amortize across).
    if (localCursor.networkHashLoaded) {
      networkCurrentHash[action.networkId] = localCursor.networkHash;
      networkActionCount[action.networkId] = localCursor.networkActionCount;
    }
    if (ba.groupSpentLoaded) sessionSpent[ba.owner][ba.signer] = ba.groupSpent;
    if (owed > 0) {
      // See processActions for the validatorId rationale.
      _requireValidatorExists(validatorId);
      cawProfile.addTokensToBalance(validatorId, owed);
    }
  }

  // ============================================
  // CAP ORACLE — PUSH RATIO INTERFACE
  // ============================================

  /// @notice Called by CawCapOracle to update the stored cap ratio.
  ///         ratio == 0 clears the cap (baseline applies). Otherwise it is a
  ///         UQ112.112 TWAP of WETH-per-CAW from the oracle.
  ///         The `capOracle` immutable is re-used for the access check — a
  ///         zero capOracle means this function is permanently unreachable.
  function setCapRatio(uint192 newRatio) external {
    if (msg.sender != address(capOracle)) revert NotCapOracle();
    capState = CapState(uint64(block.timestamp), newRatio);
    emit CapRatioUpdated(newRatio, uint64(block.timestamp));
  }

  /// @notice Read-only accessor for the oracle to probe the currently stored
  ///         ratio without a state-changing call.
  function capStateRatio() external view returns (uint192) {
    return capState.ratio;
  }

  /// @dev Helper: return pushed-ratio-capped cost, or baseline when cap is dormant.
  ///      Single SLOAD reads both fields of CapState (one 256-bit slot).
  ///      Zero capOracle (null-oracle deploy) also returns baseline — the capState
  ///      slot is always zero in that case (setCapRatio is permanently unreachable).
  function _getCost(uint256 baseline, uint256 ethCap) private view returns (uint256) {
    CapState memory s = capState; // single SLOAD
    if (s.ratio == 0) return baseline;
    if (block.timestamp - s.lastUpdatedAt > CAP_STALE_THRESHOLD) return baseline;
    uint256 capped = (ethCap << 112) / uint256(s.ratio) / 1e18;
    if (capped == 0) capped = 1;
    return capped < baseline ? capped : baseline;
  }

  /// @dev Apply a single already-authenticated action: protocol costs,
  ///      amount distribution, session spend, cawonce burn, hash-chain link.
  ///      Caller is responsible for verifying the signature (single or batch)
  ///      and for the per-action session-scope check on batch sigs.
  ///
  ///      `ba.owner` and `ba.spendLimit` are session lookups the caller has
  ///      already done — for batch sigs the lookup is amortized once per
  ///      group. Single-sig callers can pass an empty BatchAuth (with
  ///      isSessionKey/owner/spendLimit zeroed) to fetch lazily.
  function _applyAction(
    uint32 validatorId,
    ActionData memory action,
    BatchAuth memory ba,
    bytes calldata packedSlice,
    BatchCursor memory c
  ) internal returns (uint256 implicitTipOwed) {
    if (isCawonceUsed(action.senderId, action.cawonce)) revert CawonceUsed();
    if (!cawProfile.authenticated(action.networkId, action.senderId)
        && !cawProfile.allowFreeAuth(action.networkId)) revert UserNotAuth();
    if (action.text.length > 420) revert TextTooLong();

    // Fixed protocol costs per action type (in whole CAW tokens).
    // When the cap oracle is configured and populated, each baseline is
    // capped at `capOracle.capForAction(baseline, ethCap)`. The result is
    // scaled proportionally across the sub-components (distribute / recipient)
    // so economic ratios are preserved under the cap.
    // Oracle == address(0): cap dormant, baselines apply unchanged.
    uint256 actionCost;
    if (action.actionType == ActionType.CAW) {
      uint256 cost = _getCost(5000, 5e11);
      cawProfile.spendAndDistributeTokens(action.senderId, cost, cost);
      actionCost = cost;
    } else if (action.actionType == ActionType.LIKE) {
      // NOTE: self-LIKE (senderId == receiverId) is permitted on-chain.
      // Adding a `revert` would let one bad action tank the whole batch
      // (DoS surface), and an early-return would skip useCawonce below
      // (replay surface). Indexers filter self-LIKEs to avoid inflated
      // counters; the on-chain economic discount (~75% of fee returns to
      // self) is small enough not to be worth either trade. See Round 3
      // audit findings (CawActions adversarial agent, MED).
      uint256 cost = _getCost(2000, 2e11);
      // LIKE split: 20% distribute, 80% to receiver (ratios preserved under cap).
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, cost, cost / 5, action.receiverId, cost - cost / 5);
      actionCost = cost;
    } else if (action.actionType == ActionType.RECAW) {
      // Self-RECAW permitted on-chain — same rationale as self-LIKE above.
      uint256 cost = _getCost(4000, 4e11);
      // RECAW split: 50% distribute, 50% to receiver.
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, cost, cost / 2, action.receiverId, cost - cost / 2);
      actionCost = cost;
    } else if (action.actionType == ActionType.FOLLOW) {
      if (action.senderId == action.receiverId) revert SelfFollow();
      uint256 cost = _getCost(30000, 30e11);
      // FOLLOW split: 20% distribute, 80% to receiver.
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, cost, cost / 5, action.receiverId, cost - cost / 5);
      actionCost = cost;
    } else if (action.actionType == ActionType.WITHDRAW) {
      cawProfile.withdrawTokens(action.senderId, uint256(action.amounts[0]));
    } else if (action.actionType == ActionType.OTHER) {
      // OTHER actions are usually off-chain-interpreted (p:, tip:, vote:, hide:,
      // pi:, xpi:) and the contract treats them as no-ops here. Two prefixes are
      // *on-chain* state mutations:
      //   "qs:" — Quick Sign session register
      //   "qx:" — Quick Sign session revoke
      // Both are bundleable into normal action batches, so the validator gets
      // paid via the same `amounts[]` tip mechanism every other action uses.
      // Only the wallet owner's own signature can register/revoke a session —
      // a session key (ba.isSessionKey) cannot escalate by writing more sessions.
      _handleSessionAction(action, ba);
    } else if (action.actionType == ActionType.UNLIKE || action.actionType == ActionType.UNFOLLOW) {
      // Floor charge: 1000 CAW from sender to validator. Without this,
      // UNLIKE/UNFOLLOW are pure validator-gas griefing. Audit fix
      // 2026-05-09 (Round 7 econ HIGH-1).
      uint256 cost = _getCost(1000, 1e11);
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, cost, 0, validatorId, cost);
      actionCost = cost;
    } else {
      revert InvalidActionType();
    }

    // Distribute amounts (recipient transfers + tip handling)
    uint256 wholeTokens;
    (wholeTokens, implicitTipOwed) = _distributeAmountsMem(validatorId, action, ba);
    actionCost += wholeTokens;

    // Session spend limit. Accumulated in BatchAuth.groupSpent across the
    // sig group and flushed to storage once at group end — saves N-1 SSTOREs
    // per group. Lazy-load on first cost-bearing action: lookup owner if
    // not yet cached, then SLOAD sessionSpent[owner][signer] once.
    if (ba.isSessionKey && actionCost > 0) {
      if (ba.owner == address(0)) {
        ba.owner = cawProfile.ownerOf(action.senderId);
        { CawProfileL2.StoredSession memory _s = cawProfile.validSession(ba.owner, ba.signer); ba.spendLimit = _s.spendLimit; ba.perActionTipRate = _s.perActionTipRate; if (_s.profileId != 0 && _s.profileId != action.senderId) revert WrongProfileForSession(); }
      }
      if (ba.spendLimit > 0) {
        if (!ba.groupSpentLoaded) {
          ba.groupSpent = sessionSpent[ba.owner][ba.signer];
          ba.groupSpentLoaded = true;
        }
        ba.groupSpent += actionCost;
        if (ba.groupSpent > ba.spendLimit) revert SessionLimitExceeded();
      }
    }

    useCawonce(action.senderId, action.cawonce);

    // Checkpoint hash — accumulated in memory across the batch and flushed
    // once at the end of processActions / processGroupSingle. Lazy-load
    // from storage on the first action of the batch (one SLOAD instead of
    // N). r is the recovering signature's r; actionHash is keccak of the
    // packed slice (no abi.encode overhead). The chain still extends with
    // a unique actionHash per action so links are non-degenerate.
    if (!c.networkHashLoaded) {
      c.networkHash = networkCurrentHash[c.firstNetworkId];
      c.networkActionCount = networkActionCount[c.firstNetworkId];
      c.networkHashLoaded = true;
    }
    // c.networkHash = keccak256(c.networkHash || ba.r || keccak256(packedSlice))
    // Assembly avoids the memory allocation Solidity would emit for
    // abi.encodePacked of three bytes32s; we just write the three slots
    // into scratch space (0x00..0x60) and hash. Memory-safe: scratch is
    // guaranteed-free for the duration of this hash.
    bytes32 prevHash = c.networkHash;
    bytes32 sigR = ba.r;
    bytes32 newHash;
    assembly ("memory-safe") {
      // scratch slot 0 (0x00): prev hash
      mstore(0x00, prevHash)
      // scratch slot 1 (0x20): sig r
      mstore(0x20, sigR)
      // hash the slice in calldata into scratch slot 2 (0x40)
      let len := packedSlice.length
      let m := mload(0x40)
      // copy slice to free memory, hash, write digest to 0x40
      calldatacopy(m, packedSlice.offset, len)
      mstore(0x40, keccak256(m, len))
      // hash the 96-byte chain commitment
      newHash := keccak256(0x00, 0x60)
      // restore the free-memory pointer (we used it as scratch but never advanced)
      mstore(0x40, m)
    }
    c.networkHash = newHash;
    unchecked { c.networkActionCount++; }

    // Per-32-action checkpoint commitment must still hit storage — the
    // archive challenge protocol relies on indexed checkpoint hashes being
    // queryable at any time. The flush at batch end won't always cover
    // these because not every batch is a multiple of CHECKPOINT_INTERVAL.
    if (c.networkActionCount % CHECKPOINT_INTERVAL == 0) {
      networkHashAtCheckpoint[c.firstNetworkId][c.networkActionCount / CHECKPOINT_INTERVAL] = c.networkHash;
    }
  }

  // ============================================
  // QUICK SIGN SESSION DISPATCH (OTHER subtypes)
  // ============================================

  /// @dev Dispatch on-chain qs: / qx: session actions. Called from _applyAction
  ///      for any OTHER action; returns silently for any other OTHER text so
  ///      the existing off-chain subtypes (p:, tip:, vote:, hide:, pi:, xpi:)
  ///      remain no-ops at the contract level.
  ///
  ///      Encoding (binary, packed in action.text):
  ///        qs: 0x71 0x73 0x3a + addr(20) + expiry(8 BE) + spendLimit(32 BE) + tipRate(8 BE) = 71 bytes
  ///        qx: 0x71 0x78 0x3a + addr(20)                                                    = 23 bytes
  ///
  ///      Auth: the action's outer EIP-712 sig must come from the wallet owner
  ///      (NOT a session key). Session keys can't register or revoke sessions,
  ///      otherwise a compromised session could escalate.
  function _handleSessionAction(ActionData memory action, BatchAuth memory ba) internal {
    bytes memory t = action.text;
    if (t.length < 3) return;
    if (t[0] != 0x71 || t[2] != 0x3a) return; // first char 'q', third ':'
    bytes1 op = t[1];
    if (op != 0x73 && op != 0x78) return; // 's' or 'x'

    // Session keys cannot register/revoke (would escalate a compromised
    // key). Silent no-op instead of revert so one malicious session-key
    // user can't tank the whole batch — same rationale as the
    // malformed-payload returns below. Audit fix 2026-05-08 (Round 3
    // CawActions adversarial agent finding).
    if (ba.isSessionKey) return;

    // Resolve the wallet owner from the senderId. Cache on the BatchAuth
    // so subsequent actions in the same group avoid re-reading.
    if (ba.owner == address(0)) {
      ba.owner = cawProfile.ownerOf(action.senderId);
    }
    if (ba.owner == address(0)) revert UnknownOwner();

    // Malformed payloads silently no-op instead of reverting. Reverting
    // here would let one malicious user tank the whole batch (sig path
    // all-or-nothing, ZK path also reverts whole). The qs:/qx: subtypes
    // are advisory: a malformed payload from one user shouldn't halt
    // unrelated users' actions. Audit fix 2026-05-08 (CawActions M-3).
    if (op == 0x73) { // 's' — register
      if (t.length != 71) return;
      address sessionKey = _readAddress(t, 3);
      uint64 expiry = uint64(_readUint(t, 23, 8));
      uint256 spendLimit = _readUint(t, 31, 32);
      uint64 perActionTipRate = uint64(_readUint(t, 63, 8));
      cawProfile.registerSessionFromActions(ba.owner, sessionKey, expiry, spendLimit, perActionTipRate);
    } else { // 'x' — revoke
      if (t.length != 23) return;
      address sessionKey = _readAddress(t, 3);
      cawProfile.revokeSessionFromActions(ba.owner, sessionKey);
    }
  }

  /// @dev Read a 20-byte address starting at offset `o` in `b`.
  function _readAddress(bytes memory b, uint256 o) internal pure returns (address a) {
    assembly {
      // bytes layout: [length(32)][data...]. data starts at b+0x20.
      // Load 32 bytes starting at b+0x20+o, then shift right 12 bytes
      // (96 bits) to align the 20-byte address in the low bits.
      a := shr(96, mload(add(add(b, 0x20), o)))
    }
  }

  /// @dev Read a big-endian uint of `len` bytes (1..32) starting at offset `o`.
  function _readUint(bytes memory b, uint256 o, uint256 len) internal pure returns (uint256 v) {
    assembly {
      v := shr(sub(256, mul(8, len)), mload(add(add(b, 0x20), o)))
    }
  }

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================

  /// @dev Compute struct hash from memory struct. Uses assembly for the final
  ///      abi.encode to avoid memory allocation, but keeps abi.encodePacked in
  ///      Solidity for array hashing correctness.
  function _computeStructHash(ActionData memory data) internal pure returns (bytes32 result) {
    bytes32 recipHash = keccak256(abi.encodePacked(data.recipients));
    bytes32 amtHash = keccak256(abi.encodePacked(data.amounts));
    bytes32 textHash = keccak256(data.text);
    bytes32 typeHash = ACTIONDATA_TYPEHASH;

    // Build the abi.encode buffer in scratch memory (no allocation needed)
    assembly {
      let buf := mload(0x40)
      mstore(buf,              typeHash)
      mstore(add(buf, 0x20),   mload(data))              // actionType
      mstore(add(buf, 0x40),   mload(add(data, 0x20)))   // senderId
      mstore(add(buf, 0x60),   mload(add(data, 0x40)))   // receiverId
      mstore(add(buf, 0x80),   mload(add(data, 0x60)))   // receiverCawonce
      mstore(add(buf, 0xA0),   mload(add(data, 0x80)))   // networkId
      mstore(add(buf, 0xC0),   mload(add(data, 0xA0)))   // cawonce
      mstore(add(buf, 0xE0),   recipHash)
      mstore(add(buf, 0x100),  amtHash)
      mstore(add(buf, 0x120),  textHash)
      result := keccak256(buf, 0x140)
    }
  }

  /// @dev Bounded ERC-1271 verification. Forwards a fixed gas stipend so a
  ///      malicious contract owner cannot drain a relaying validator with an
  ///      expensive isValidSignature. Out-of-gas inside the staticcall surfaces
  ///      as a `false` return, identical to a 1271 reject — the action fails
  ///      verification but the relaying tx isn't burned.
  function _checkERC1271(address owner, bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal view returns (bool) {
    bytes memory sig = abi.encodePacked(r, s, v);
    (bool ok, bytes memory ret) = owner.staticcall{gas: ERC1271_GAS_LIMIT}(
      abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig)
    );
    return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC_VALUE;
  }

  function _verifySignatureMem(
    uint8 v, bytes32 r, bytes32 s,
    ActionData memory data
  ) internal view returns (address signer, bool isSessionKey) {
    bytes32 structHash = _computeStructHash(data);

    signer = getSigner(structHash, v, r, s);
    address owner = cawProfile.ownerOf(data.senderId);

    if (signer == owner && signer != address(0)) return (signer, false);

    if (signer != address(0)) {
      CawProfileL2.StoredSession memory sess = cawProfile.validSession(owner, signer);
      if (sess.expiry > block.timestamp) {
        if ((sess.scopeBitmap & (1 << uint8(data.actionType))) == 0) revert OutOfScope();
        return (signer, true);
      }
      // Session record exists but is expired. Don't fall through to the
      // ERC-1271 path — for a contract-owned profile (Safe etc.) where the
      // signer is a Safe-validated key that ALSO had a session record, the
      // 1271 fallback would silently elevate the expired session to full
      // owner authority. Explicit revert keeps the intent the user signed.
      // Audit fix 2026-05-08 (CawActions M-1).
      if (sess.expiry != 0) revert SessionExpired();
    }

    // Cold path: contract-owned profile, ERC-1271 fallback. The 1271 contract
    // validates against the full EIP-712 digest (the same bytes the EOA would
    // have signed), not the bare structHash. Gas-bounded — see _checkERC1271.
    if (owner.code.length > 0) {
      bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, structHash));
      if (!_checkERC1271(owner, digest, v, r, s)) revert InvalidSig();
      return (owner, false);
    }

    if (signer == address(0)) revert InvalidSig();
    revert SessionExpired();
  }

  /// @dev Recover the signer of an ActionBatch signature. Performs the same
  ///      owner-or-session-key resolution as _verifySignatureMem, except the
  ///      per-action scope check is the caller's job (batch covers many
  ///      actions, each of which must be checked against the bitmap).
  ///
  /// @dev On the no-valid-signer path this reverts with "Batch signature did
  ///      not recover a valid signer" rather than the single-sig path's
  ///      "Session invalid". For batch sigs, the failure is
  ///      most often that the validator submitted a different actionsHash
  ///      than what the user signed (e.g. the group was truncated across
  ///      txs) — ecrecover returns a random non-zero address that has no
  ///      session, and the misleading "session expired" message used to
  ///      bubble up to the UI as "Quick Sign expired", confusing users who
  ///      had perfectly fine sessions. The new message is accurate to the
  ///      contract's view (the signer is wrong), regardless of whether the
  ///      cause was message tampering, a stale session, or a forged sig.
  function _verifyBatchSignature(
    uint8 v, bytes32 r, bytes32 s,
    uint32 senderId,
    uint32 firstCawonce,
    uint32 batchActionCount,
    bytes32 actionsHash
  ) internal view returns (address signer, bool isSessionKey) {
    bytes32 structHash = keccak256(abi.encode(
      ACTIONBATCH_TYPEHASH,
      senderId,
      firstCawonce,
      batchActionCount,
      actionsHash
    ));
    signer = getSigner(structHash, v, r, s);
    address owner = cawProfile.ownerOf(senderId);

    if (signer == owner && signer != address(0)) return (signer, false);

    if (signer != address(0)) {
      uint64 expiry = cawProfile.validSession(owner, signer).expiry;
      if (expiry > block.timestamp) return (signer, true);
      // See _verifySignatureMem for the rationale — don't let an expired
      // session fall through to ERC-1271, which would silently elevate it
      // to owner authority. Audit fix 2026-05-08 (CawActions M-1).
      if (expiry != 0) revert("Session expired");
    }

    // Cold path: contract-owned profile, ERC-1271 fallback. Same digest the
    // EOA would have signed for an ActionBatch. Gas-bounded — see _checkERC1271.
    if (owner.code.length > 0) {
      bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, structHash));
      if (!_checkERC1271(owner, digest, v, r, s)) revert BatchSigInvalid();
      return (owner, false);
    }

    revert BatchSigInvalid();
  }

  // ============================================
  // AMOUNT DISTRIBUTION (memory struct version)
  // ============================================

  /// @dev Distribute amounts. Two flavors:
  ///
  ///      Manual-sign / explicit-tip: amounts.length == recipients.length + 1.
  ///        The trailing entry is a per-action validator tip credited inline via
  ///        addToBalance(validatorId, ...). `implicitTipOwed` returns 0 — the
  ///        outer batch loop has nothing to amortize.
  ///
  ///      Recipient-only: amounts.length == recipients.length (>= 0).
  ///        No trailing tip slot. For session-key actions, the implicit tip
  ///        from the session record is returned as `implicitTipOwed` so the
  ///        outer batch loop can sum it across all session-key actions and
  ///        credit the validator with one SSTORE at the end. For non-session
  ///        actions (manual-sign with no tip — unusual but allowed) it stays 0.
  ///
  ///      `totalWholeTokens` is the action's contribution to the user's session
  ///      spend (recipient distributions + implicit tip if applicable). Manual-
  ///      sign explicit-tip flows use the trailing-amount value as before.
  function _distributeAmountsMem(uint32 validatorId, ActionData memory action, BatchAuth memory ba)
    internal returns (uint256 totalWholeTokens, uint256 implicitTipOwed)
  {
    uint256 numRecipients = action.recipients.length;
    uint256 numAmounts = action.amounts.length;

    if (numRecipients > 10) revert TooManyRecipients();

    bool hasExplicitTip = numAmounts == numRecipients + 1;
    if (numAmounts != numRecipients && !hasExplicitTip)
      revert InvalidActionType();

    // For WITHDRAW with `recipients=[]` and `amounts=[X]`, the shape would
    // be misread as hasExplicitTip (numAmounts == 0+1), which would BOTH
    // (a) re-spend X via spendAndDistribute AND (b) credit X to the
    // validator as a "tip" — double-debiting the user and silently paying
    // the validator a free tip. The legitimate empty-recipients-WITHDRAW
    // shape is "amounts==[X]" with no tip slot; reject the ambiguity by
    // requiring at least one recipient when amounts has length 1 for a
    // WITHDRAW. Audit fix 2026-05-08 (H-2, CawActions agent finding).
    bool isWithdrawal = action.actionType == ActionType.WITHDRAW;
    if (isWithdrawal && numRecipients == 0 && hasExplicitTip) revert InvalidActionType();

    // Fast path: no recipients, no explicit tip. Session-key actions
    // owe the implicit tip; OTHER actions with no tip mechanism firing
    // pay a 1000 CAW floor so validators aren't griefed by free
    // submissions (vote:, pi:, p:, hide:, qs:/qx: with empty amounts —
    // every OTHER subtype that doesn't otherwise pay). Other action
    // types either have a fixed protocol-cost (CAW/LIKE/RECAW/FOLLOW)
    // or their own floor (UNLIKE/UNFOLLOW). Audit fix 2026-05-09
    // (Round 7 econ HIGH-1 extension to OTHER).
    if (numRecipients == 0 && !hasExplicitTip) {
      if (ba.isSessionKey && ba.perActionTipRate > 0) {
        implicitTipOwed = uint256(ba.perActionTipRate);
        totalWholeTokens = implicitTipOwed;
      } else if (action.actionType == ActionType.OTHER) {
        _requireValidatorExists(validatorId);
        uint256 otherCost = _getCost(1000, 1e11);
        cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, otherCost, 0, validatorId, otherCost);
        totalWholeTokens = otherCost;
      }
      return (totalWholeTokens, implicitTipOwed);
    }

    _requireValidatorExists(validatorId);

    uint256 startIndex = isWithdrawal ? 1 : 0;

    if (hasExplicitTip) {
      totalWholeTokens = uint256(action.amounts[numAmounts - 1]);
    }

    for (uint256 i = startIndex; i < numRecipients; ) {
      uint256 amt = uint256(action.amounts[i]);
      cawProfile.addTokensToBalance(action.recipients[i], amt);
      totalWholeTokens += amt;
      unchecked { ++i; }
    }

    // Single 10**18 multiplication at the boundary instead of one per
    // recipient + one for the tip. spendAndDistribute takes wei.
    cawProfile.spendAndDistribute(action.senderId, totalWholeTokens * 10**18, 0);

    if (hasExplicitTip) {
      // Manual-sign / legacy: per-action SSTORE. (Session-key actions are
      // expected to use the empty-tip-slot path and amortize via batch end.)
      cawProfile.addTokensToBalance(validatorId, uint256(action.amounts[numAmounts - 1]));
    } else if (ba.isSessionKey && ba.perActionTipRate > 0) {
      // Recipient distribution + implicit session tip — defer the validator
      // credit to the batch-end accumulator.
      implicitTipOwed = uint256(ba.perActionTipRate);
      totalWholeTokens += implicitTipOwed;
    }
  }

  // ============================================
  // PACKED DATA READERS
  // ============================================

  /// @dev Unpack one action from packed calldata using assembly for efficient
  ///      calldataload reads instead of byte-by-byte Solidity indexing.
  function _unpackAction(bytes calldata packed, uint256 pos)
    internal pure returns (ActionData memory action, uint256 nextPos)
  {
    uint256 rc;
    uint256 ac;

    assembly {
      let cdOff := add(packed.offset, pos)

      // Load first 32 bytes — contains all fixed fields (21 bytes) + rc + ac
      let w := calldataload(cdOff)
      // actionType: 1 byte at bits [255..248]
      mstore(action, shr(248, w))
      // senderId: 4 bytes at bits [247..216]
      mstore(add(action, 0x20), and(shr(216, w), 0xFFFFFFFF))
      // receiverId: 4 bytes at bits [215..184]
      mstore(add(action, 0x40), and(shr(184, w), 0xFFFFFFFF))
      // receiverCawonce: 4 bytes at bits [183..152]
      mstore(add(action, 0x60), and(shr(152, w), 0xFFFFFFFF))
      // networkId: 4 bytes at bits [151..120]
      mstore(add(action, 0x80), and(shr(120, w), 0xFFFFFFFF))
      // cawonce: 4 bytes at bits [119..88]
      mstore(add(action, 0xA0), and(shr(88, w), 0xFFFFFFFF))
      // rc: 1 byte at bits [87..80]
      rc := and(shr(80, w), 0xFF)
      // ac: 1 byte at bits [79..72]
      ac := and(shr(72, w), 0xFF)

      pos := add(pos, 23) // 21 fixed + 1 rc + 1 ac
    }

    // Allocate arrays in Solidity (safe memory management)
    action.recipients = new uint32[](rc);
    action.amounts = new uint64[](ac);

    assembly {
      // Fill recipients array from calldata
      let recipPtr := mload(add(action, 0xC0)) // pointer to recipients array
      let cdOff := add(packed.offset, pos)
      for { let j := 0 } lt(j, rc) { j := add(j, 1) } {
        let val := and(shr(224, calldataload(add(cdOff, mul(j, 4)))), 0xFFFFFFFF)
        mstore(add(add(recipPtr, 0x20), mul(j, 0x20)), val)
      }
      pos := add(pos, mul(rc, 4))

      // Fill amounts array from calldata
      let amtPtr := mload(add(action, 0xE0))
      cdOff := add(packed.offset, pos)
      for { let j := 0 } lt(j, ac) { j := add(j, 1) } {
        let val := and(shr(192, calldataload(add(cdOff, mul(j, 8)))), 0xFFFFFFFFFFFFFFFF)
        mstore(add(add(amtPtr, 0x20), mul(j, 0x20)), val)
      }
      pos := add(pos, mul(ac, 8))
    }

    // Text: calldata slice (Solidity handles the memory copy)
    uint256 tl;
    assembly {
      tl := shr(240, calldataload(add(packed.offset, pos)))
      pos := add(pos, 2)
    }
    action.text = packed[pos : pos + tl];
    pos += tl;

    nextPos = pos;
  }

  // ============================================
  // WITHDRAWAL HELPERS
  // ============================================

  /// @dev Scan packed actions to collect withdrawal IDs and amounts.
  ///
  /// SECURITY INVARIANT (audited 2026-04-27, hardened 2026-04-28):
  ///   This function reads `firstAmount` directly from calldata at the
  ///   amounts-array offset, INCLUDING the case where `ac == 0` (where the
  ///   load picks up the textLength bytes instead). The if-block guarding
  ///   the consumption of `firstAmount` now requires `acOut > 0` locally,
  ///   so even if _distributeAmountsMem's upstream enforcement ever changes,
  ///   no withdrawal amount can be credited from the textLength field.
  ///
  ///   The upstream chain that previously made this safe end-to-end:
  ///     1. processActions / safeProcessActions runs the per-action loop
  ///        (_processOneGroup → _applyAction → _distributeAmountsMem).
  ///     2. _distributeAmountsMem requires that WITHDRAW actions have at
  ///        least one entry in `amounts` (since `numAmounts == numRecipients
  ///        + 1` is enforced when amounts are present).
  ///     3. Only after that loop completes successfully does
  ///        _handleWithdrawals run.
  ///   The local require below is defense-in-depth for that chain.
  function _handleWithdrawals(
    uint256 withdrawBitmap,
    uint256 withdrawCount,
    uint256 actionCount,
    bytes calldata packedActions
  ) internal {
    uint32[] memory withdrawIds = new uint32[](withdrawCount);
    uint256[] memory withdrawAmounts = new uint256[](withdrawCount);
    uint16 wIdx = 0;
    uint256 pos = 2; // skip header

    for (uint256 i = 0; i < actionCount; ) {
      uint32 senderId;
      uint64 firstAmount;
      uint256 acOut;
      assembly {
        let cdOff := add(packedActions.offset, pos)
        let w := calldataload(cdOff)
        // senderId at offset 1 (bits 247..216)
        senderId := and(shr(216, w), 0xFFFFFFFF)
        // rc at offset 21 (bits 87..80), ac at offset 22 (bits 79..72)
        let rc := and(shr(80, w), 0xFF)
        let ac := and(shr(72, w), 0xFF)
        acOut := ac
        // Skip: 23 fixed + rc*4 recipients
        let amtOff := add(add(cdOff, 23), mul(rc, 4))
        // First amount (8 bytes). When ac==0 this reads the textLength bytes,
        // not an amount — harmless because the if-block below requires ac > 0
        // before consuming firstAmount, and _distributeAmountsMem enforces
        // that WITHDRAW actions always have amounts upstream.
        firstAmount := and(shr(192, calldataload(amtOff)), 0xFFFFFFFFFFFFFFFF)
        // Skip: amounts + textLength + text
        amtOff := add(amtOff, mul(ac, 8))
        let tl := shr(240, calldataload(amtOff))
        pos := sub(add(add(amtOff, 2), tl), packedActions.offset)
      }

      if ((withdrawBitmap & (1 << i)) != 0) {
        // Defense-in-depth: make the "WITHDRAW has at least one amount"
        // invariant local. If _distributeAmountsMem's upstream enforcement
        // ever changes, this catches the mismatch instead of crediting a
        // withdrawal amount derived from the textLength field.
        if (acOut == 0) revert WithdrawZeroAmount();
        withdrawIds[wIdx] = senderId;
        withdrawAmounts[wIdx] = uint256(firstAmount) * 10**18;
        unchecked { ++wIdx; }
      }

      unchecked { ++i; }
    }

    // Store for _executeWithdrawals
    _pendingWithdrawIds = withdrawIds;
    _pendingWithdrawAmounts = withdrawAmounts;
  }

  uint32[] private _pendingWithdrawIds;
  uint256[] private _pendingWithdrawAmounts;

  /// @dev NOTE TO FUTURE AUDITORS: the storage-scratch pattern here
  ///      (_pendingWithdrawIds / _pendingWithdrawAmounts written by
  ///      _handleWithdrawals, consumed + deleted by _executeWithdrawals,
  ///      with no nonReentrant guard on the entry points) was re-examined
  ///      2026-05-17 and intentionally left as-is. Reentrancy chain
  ///      considered: _executeWithdrawals → cawProfile.setWithdrawable →
  ///      lzSend → endpoint callback → re-entry into processActions.
  ///      Not reachable, because (1) the bypassLZ branch of
  ///      CawProfileL2.setWithdrawable calls CawProfile.setWithdrawable
  ///      on L1 which performs no external calls (see CawProfile.sol:820
  ///      audit note), and (2) the LZ branch hands the native fee to the
  ///      canonical OApp endpoint, which emits an event and does not
  ///      execute source-chain code in the same call stack — destination
  ///      _lzReceive is a separate tx on the destination chain. The OApp
  ///      endpoint is the protocol's immutable trust root; if a future
  ///      hostile endpoint is ever wired in, nonReentrant does not save
  ///      us anyway. Pattern violates checks-effects-interactions
  ///      cosmetically but the reachable attack surface is empty.
  function _executeWithdrawals(uint256 withdrawFee, uint256 lzTokenAmount) internal {
    if (_pendingWithdrawIds.length > 0) {
      cawProfile.setWithdrawable{ value: withdrawFee }(
        _pendingWithdrawIds, _pendingWithdrawAmounts, lzTokenAmount
      );
      delete _pendingWithdrawIds;
      delete _pendingWithdrawAmounts;
    }
  }

  // ============================================
  // EXISTING UTILITIES (unchanged)
  // ============================================

  /// @dev Reverts when validatorId doesn't correspond to a minted token.
  ///      Hoisted from inline call sites so the require body bytecode is
  ///      shared. Audit fix 2026-05-08 (Round 4 CawActions LOW-1).
  function _requireValidatorExists(uint32 validatorId) internal view {
    if (cawProfile.ownerOf(validatorId) == address(0)) revert InvalidValidator();
  }

  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce >> 8;
    uint256 bit = cawonce & 0xff;
    // Compute new word locally and check completeness off the freshly-computed
    // value — saves a redundant warm SLOAD of usedCawonce[senderId][word]
    // versus the older reload-after-write pattern.
    uint256 newWord = usedCawonce[senderId][word] | (1 << bit);
    usedCawonce[senderId][word] = newWord;
    if (newWord == type(uint256).max) {
      currentCawonceMap[senderId] = word + 1;
    }
  }

  function nextCawonce(uint32 senderId) public view returns (uint256) {
    uint256 currentMap = currentCawonceMap[senderId];
    uint256 word = usedCawonce[senderId][currentMap];
    if (word == 0) return currentMap * 256;
    uint256 nextSlot;
    for (nextSlot = 0; nextSlot < 256; ) {
      if (((1 << nextSlot) & word) == 0) break;
      unchecked { ++nextSlot; }
    }
    return (currentMap * 256) + nextSlot;
  }

  function isCawonceUsed(uint32 senderId, uint256 cawonce) public view returns (bool) {
    uint256 word = cawonce >> 8;
    uint256 bit = cawonce & 0xff;
    return (usedCawonce[senderId][word] & (1 << bit)) != 0;
  }

  function getSigner(
    bytes32 structHash,
    uint8 v, bytes32 r, bytes32 s
  ) internal view returns (address) {
    bytes32 hash = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, structHash));
    return ecrecover(hash, v, r, s);
  }

  function generateDomainHash() public view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("Caw Protocol")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
      )
    );
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken)
    external view returns (MessagingFee memory quote)
  {
    return cawProfile.withdrawQuote(tokenIds, amounts, payInLzToken);
  }
}
