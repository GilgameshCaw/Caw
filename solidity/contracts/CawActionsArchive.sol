// contracts/CawActionsArchive.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import "./OnlyOnce.sol";

/**
 * @title CawActionsArchive
 * @notice Deployed on archive chains. Validators stake once, then submit
 *         replication data freely. Fraud proofs via LZ slash the entire stake.
 *
 * @dev Stake model:
 *   - Validator deposits ETH via deposit(). Stake covers all submissions.
 *   - submitReplication() requires stake >= MIN_STAKE, no ETH per call.
 *   - On fraud: entire stake slashed, ALL pending submissions invalidated.
 *   - Withdraw only when zero pending submissions.
 *
 * Trust model:
 *   - merkleRoot commits to checkpoint hashes; checkpoint hashes commit to actions.
 *   - Fraud proofs arrive via LZ from a canonical CawChallengeRelay on each
 *     source chain. The archive owner pairs one peer per source EID via
 *     setPeer, then ownership is renounced — zero admin post-setup.
 *   - At least one honest validator must monitor within CHALLENGE_PERIOD.
 */
contract CawActionsArchive is Ownable, ReentrancyGuard, OnlyOnce, OApp {

  // ============================================
  // TYPES
  // ============================================

  enum Status { PENDING, FINALIZED, SLASHED }

  struct Submission {
    address submitter;
    bytes32 merkleRoot;
    uint32  clientId;
    uint64  startCheckpointId;
    uint64  endCheckpointId;
    uint64  finalizedAt;
    Status  status;
    // Commitment to the submitter-supplied packedActions + r[]. Lets
    // slashIncoherentRoot verify that the data a caller re-hashes is the
    // exact data that was originally submitted — without storing the full
    // bytes on-chain (they live in the ActionsArchived event log).
    bytes32 dataCommitment;
  }

  // ============================================
  // CONSTANTS
  // ============================================

  uint256 public constant CHALLENGE_PERIOD = 2 days;
  uint256 public constant MIN_STAKE = 0.01 ether;
  uint256 public constant CHECKPOINT_INTERVAL = 32;
  uint256 public constant MAX_CHECKPOINTS_PER_SUBMISSION = 256;

  // ============================================
  // STATE
  // ============================================

  uint256 public nextSubmissionId = 1;
  mapping(uint256 => Submission) public submissions;

  /// @notice Validator stakes: address => staked ETH amount
  mapping(address => uint256) public stakes;

  /// @notice Count of pending (unfinalized, unslashed) submissions per validator
  mapping(address => uint256) public pendingCount;

  /// @notice Submission IDs belonging to a validator (for bulk invalidation on slash)
  mapping(address => uint256[]) public validatorSubmissions;

  /// @notice clientId => checkpointId => submissionId that covers it
  mapping(uint32 => mapping(uint256 => uint256)) public checkpointClaimed;

  /// @notice submissionId => checkpointId => correctHash from LZ
  mapping(uint256 => mapping(uint256 => bytes32)) public challengeHash;
  mapping(uint256 => mapping(uint256 => bool)) public challengeDelivered;

  // ============================================
  // EVENTS
  // ============================================

  event Deposited(address indexed validator, uint256 amount, uint256 totalStake);
  event Withdrawn(address indexed validator, uint256 amount, uint256 remaining);

  event SubmissionCreated(
    uint256 indexed submissionId,
    address indexed submitter,
    uint32 indexed clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes32 merkleRoot
  );

  /// @notice Commitment to a submission's underlying data. The full packedActions
  ///         and r[] arrays live in the originating tx's calldata (the same
  ///         arguments passed to submitReplication); challengers and indexers
  ///         fetch them via eth_getTransactionByHash and validate against
  ///         `packedHash` / `rHash`. `entryHash` is small and stays inline.
  event ActionsArchived(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    uint16 actionCount,
    bytes32 packedHash,
    bytes32 rHash,
    bytes32 entryHash
  );

  event SubmissionFinalized(uint256 indexed submissionId);

  event ValidatorSlashed(
    address indexed validator,
    address indexed challenger,
    uint256 submissionId,
    uint256 checkpointId,
    uint256 reward
  );

  event ChallengeHashDelivered(
    uint256 indexed submissionId,
    uint256 checkpointId,
    bytes32 correctHash
  );

  // ============================================
  // CONSTRUCTOR
  // ============================================

  constructor(address _endpoint) OApp(_endpoint, msg.sender) {}

  /// @notice Lock the inherited OApp `setPeer` once per eid. Once a peer is set
  /// in deploy, it can NEVER be changed — even by the owner. Critical here because
  /// the canonical CawChallengeRelay on each source chain is what we trust to deliver
  /// fraud proofs; a swapped peer could send forged "everything is fine" / "this is
  /// fraud" messages. New eids stay openable so future chains can be added.
  function setPeer(uint32 _eid, bytes32 _peer)
    public
    override
    onlyOnce(keccak256(abi.encode("setPeer", _eid)))
  {
    super.setPeer(_eid, _peer);
  }

  // ============================================
  // STAKING
  // ============================================

  /// @notice Deposit ETH as stake. Covers all future submissions.
  function deposit() external payable {
    require(msg.value > 0, "Zero deposit");
    stakes[msg.sender] += msg.value;
    emit Deposited(msg.sender, msg.value, stakes[msg.sender]);
  }

  /// @notice Withdraw stake. Only allowed when no pending submissions.
  /// @param amount Amount to withdraw (0 = withdraw all)
  function withdraw(uint256 amount) external nonReentrant {
    require(pendingCount[msg.sender] == 0, "Has pending submissions");
    uint256 available = stakes[msg.sender];
    uint256 toSend = amount == 0 ? available : amount;
    require(toSend > 0 && toSend <= available, "Invalid amount");

    stakes[msg.sender] -= toSend;
    (bool ok,) = msg.sender.call{value: toSend}("");
    require(ok, "Transfer failed");

    emit Withdrawn(msg.sender, toSend, stakes[msg.sender]);
  }

  // ============================================
  // SUBMISSION
  // ============================================

  /// @notice Submit checkpoint data for archival. Requires sufficient stake.
  /// @param entryHash  The clientCurrentHash on the source L2 at
  ///                   checkpoint (startCheckpointId - 1). This is the
  ///                   value fed into the hash chain as the initial
  ///                   "prev" hash — committing it lets slashIncoherentRoot
  ///                   verify the full fold deterministically.
  function submitReplication(
    uint32 clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes calldata packedActions,
    bytes32[] calldata r,
    bytes32 merkleRoot,
    bytes32 entryHash
  ) external {
    require(stakes[msg.sender] >= MIN_STAKE, "Insufficient stake");
    require(startCheckpointId > 0, "Invalid start");
    require(endCheckpointId >= startCheckpointId, "Invalid range");

    uint256 numCheckpoints = endCheckpointId - startCheckpointId + 1;
    require(numCheckpoints <= MAX_CHECKPOINTS_PER_SUBMISSION, "Too many checkpoints");

    uint256 expectedActions = numCheckpoints * CHECKPOINT_INTERVAL;
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
    require(actionCount == expectedActions, "Action count mismatch");
    require(r.length == expectedActions, "r length mismatch");
    require(merkleRoot != bytes32(0), "Empty merkle root");

    // Ensure no checkpoint in the range is already claimed
    for (uint256 cp = startCheckpointId; cp <= endCheckpointId; ) {
      require(checkpointClaimed[clientId][cp] == 0, "Checkpoint already claimed");
      unchecked { ++cp; }
    }

    uint256 submissionId = nextSubmissionId++;

    // Commit to the submitted packedActions + r + entryHash so
    // slashIncoherentRoot can verify a later caller is re-supplying the
    // exact bytes that were submitted. The component hashes are reused in
    // the ActionsArchived event so off-chain consumers can validate
    // calldata they refetch from this tx.
    bytes32 packedHash = keccak256(packedActions);
    bytes32 rHash = keccak256(abi.encodePacked(r));
    bytes32 dataCommitment = keccak256(abi.encodePacked(packedHash, rHash, entryHash));

    submissions[submissionId] = Submission({
      submitter: msg.sender,
      merkleRoot: merkleRoot,
      clientId: clientId,
      startCheckpointId: uint64(startCheckpointId),
      endCheckpointId: uint64(endCheckpointId),
      finalizedAt: uint64(block.timestamp + CHALLENGE_PERIOD),
      status: Status.PENDING,
      dataCommitment: dataCommitment
    });

    for (uint256 cp = startCheckpointId; cp <= endCheckpointId; ) {
      checkpointClaimed[clientId][cp] = submissionId;
      unchecked { ++cp; }
    }

    pendingCount[msg.sender]++;
    validatorSubmissions[msg.sender].push(submissionId);

    emit SubmissionCreated(submissionId, msg.sender, clientId, startCheckpointId, endCheckpointId, merkleRoot);
    // Emit a *commitment* to the submitter-supplied data. The full
    // packedActions and r[] live in this tx's calldata; off-chain
    // monitors fetch them via eth_getTransactionByHash and validate
    // against packedHash / rHash. entryHash stays inline so monitors
    // can compare it against the source L2's
    // clientHashAtCheckpoint(clientId, startCheckpointId-1) without
    // any extra fetch.
    emit ActionsArchived(submissionId, clientId, uint16(actionCount), packedHash, rHash, entryHash);
  }

  // ============================================
  // FINALIZATION
  // ============================================

  /// @notice Finalize a submission after the challenge period. Anyone can call.
  function finalizeSubmission(uint256 submissionId) external {
    Submission storage sub = submissions[submissionId];
    require(sub.status == Status.PENDING, "Not pending");
    require(block.timestamp >= sub.finalizedAt, "Challenge period active");

    sub.status = Status.FINALIZED;
    pendingCount[sub.submitter]--;
    emit SubmissionFinalized(submissionId);
  }

  // ============================================
  // CHALLENGE - LZ RECEIVE
  // ============================================

  /// @dev Emitted when an LZ challenge message could not be processed — kept
  ///      so the channel stays alive. Off-chain tooling can resubmit via a
  ///      fresh relayChallenge call once the cause is identified.
  ///
  /// RECOVERY (audited 2026-04-27):
  ///   The try/catch around _processChallenge prevents an LZ channel stall
  ///   if a single message reverts, but it ALSO swallows legitimate failures
  ///   (out-of-gas at the executor, malformed payload, future-added storage
  ///   checks). When a fraud proof is dropped, `challengeHash` and
  ///   `challengeDelivered` are NOT set for the affected checkpoint, and
  ///   resolveChallenge will revert with "No challenge delivered" until
  ///   someone re-relays.
  ///
  ///   The recovery path is to call CawChallengeRelay.relayChallenge or
  ///   .relayChallengeBatch again with the same (submissionId, clientId,
  ///   checkpointId(s)). The relay re-reads from CawActions checkpoint
  ///   storage (which is permanent) and emits a fresh LZ message — anyone
  ///   can call it, no operator privileges required. The archive's executor
  ///   gas option (CHALLENGE_GAS_BASE = 60_000 + CHALLENGE_GAS_PER_CP =
  ///   55_000 per checkpoint) provides ~30% headroom over the worst-case
  ///   _processChallenge cost (2 SSTOREs + event per cp, ~50k gas each), so
  ///   gas exhaustion at the executor should not be the failure mode in
  ///   practice. If it ever is, callers can pre-quote a higher gas option
  ///   (the relay's gas constants are not configurable post-deploy, so the
  ///   safe path is to redeploy a new relay with higher constants and peer
  ///   it via setPeer for a fresh eid — existing peers are immutable).
  event ChallengeDeliveryFailed(bytes payload, bytes reason);

  /// @dev Receives correct checkpoint hash from CawChallengeRelay via LZ.
  ///      The default OAppReceiver peer check (msg.sender == endpoint, and
  ///      origin.sender == peers[srcEid]) restricts this to the canonical relay
  ///      the archive owner peered at deploy time.
  ///
  ///      SAFETY: the body runs inside a try/catch self-call so that any
  ///      revert (bad abi.decode, malformed payload, future-added check)
  ///      does NOT stall the LZ channel nonce. A reverting _lzReceive in
  ///      LZ V2 blocks every subsequent challenge from that source chain
  ///      until someone manually retries the stuck nonce. With this
  ///      isolation, a single bad message is a logged failure, not an
  ///      infrastructure outage.
  ///
  ///      RECOVERY: see the ChallengeDeliveryFailed docstring above for the
  ///      re-relay flow when this catch fires.
  function _lzReceive(
    Origin calldata,
    bytes32,
    bytes calldata payload,
    address,
    bytes calldata
  ) internal override {
    try this._processChallenge(payload) {
      // ok
    } catch (bytes memory reason) {
      emit ChallengeDeliveryFailed(payload, reason);
    }
  }

  /// @dev Isolated body of _lzReceive. External so _lzReceive can try/catch
  ///      it, but restricted to self-calls only — the explicit check plus
  ///      the fact that _lzReceive is the only caller make this safe.
  function _processChallenge(bytes calldata payload) external {
    require(msg.sender == address(this), "only self");

    // Payload is always the batch shape: (submissionId, clientId, cps[], hashes[]).
    // Single-cp callers send arrays of length 1; the relay's two public
    // entrypoints (relayChallenge / relayChallengeBatch) produce identical
    // payloads, so there's one decode path here.
    (uint256 submissionId, uint32 clientId, uint256[] memory cps, bytes32[] memory hashes) =
      abi.decode(payload, (uint256, uint32, uint256[], bytes32[]));

    Submission storage sub = submissions[submissionId];
    if (sub.status != Status.PENDING) return;
    if (sub.clientId != clientId) return;
    if (cps.length != hashes.length) return;

    uint256 start = sub.startCheckpointId;
    uint256 end = sub.endCheckpointId;
    for (uint256 i = 0; i < cps.length; i++) {
      uint256 cpId = cps[i];
      if (cpId < start || cpId > end) continue; // out-of-range entries are silently dropped
      challengeHash[submissionId][cpId] = hashes[i];
      challengeDelivered[submissionId][cpId] = true;
      emit ChallengeHashDelivered(submissionId, cpId, hashes[i]);
    }
  }

  // ============================================
  // CHALLENGE - RESOLUTION
  // ============================================

  /// @notice Resolve a challenge. Slashes the validator's ENTIRE stake and
  ///         invalidates ALL their pending submissions.
  function resolveChallenge(
    uint256 submissionId,
    uint256 checkpointId,
    bytes32 claimedHash,
    bytes32[] calldata merkleProof
  ) external nonReentrant {
    Submission storage sub = submissions[submissionId];
    require(sub.status == Status.PENDING, "Not pending");
    require(challengeDelivered[submissionId][checkpointId], "No challenge delivered");

    // Verify claimedHash is what the submitter committed via merkle proof
    bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(checkpointId, claimedHash))));
    require(MerkleProof.verify(merkleProof, sub.merkleRoot, leaf), "Invalid merkle proof");

    // Correct hash from L2 must differ from claimed hash
    bytes32 correctHash = challengeHash[submissionId][checkpointId];
    require(correctHash != claimedHash, "Hashes match, no fraud");

    address validator = sub.submitter;
    uint256 reward = stakes[validator];
    stakes[validator] = 0;

    // Invalidate ALL pending submissions from this validator
    uint256[] storage subIds = validatorSubmissions[validator];
    for (uint256 i = 0; i < subIds.length; ) {
      uint256 sid = subIds[i];
      Submission storage s = submissions[sid];
      if (s.status == Status.PENDING) {
        s.status = Status.SLASHED;
        // Release checkpoint claims
        for (uint256 cp = s.startCheckpointId; cp <= s.endCheckpointId; ) {
          checkpointClaimed[s.clientId][cp] = 0;
          unchecked { ++cp; }
        }
      }
      unchecked { ++i; }
    }
    pendingCount[validator] = 0;

    // Clear the history array so a re-staking validator starts fresh. Without
    // this, repeated slashes would re-scan a growing list each time.
    delete validatorSubmissions[validator];

    // Pay the challenger
    if (reward > 0) {
      (bool ok,) = msg.sender.call{value: reward}("");
      require(ok, "Transfer failed");
    }

    emit ValidatorSlashed(validator, msg.sender, submissionId, checkpointId, reward);
  }

  // ============================================
  // CHALLENGE - INCOHERENT ROOT (Mode A)
  // ============================================

  /// @notice Slash a submitter whose committed merkleRoot does not match the
  ///         root computed from their own packedActions + r + entryHash.
  /// @dev This catches a class of fraud resolveChallenge cannot:
  ///      submitter committed a merkleRoot that isn't even derivable from
  ///      the data they published, so no valid merkle proof exists for any
  ///      leaf. The caller re-supplies the submitter's own bytes, the
  ///      contract verifies they match the at-submit-time dataCommitment,
  ///      re-folds the hash chain, rebuilds the root, and slashes if
  ///      (and only if) the rebuilt root differs from the committed one.
  function slashIncoherentRoot(
    uint256 submissionId,
    bytes calldata packedActions,
    bytes32[] calldata r,
    bytes32 entryHash
  ) external nonReentrant {
    Submission storage sub = submissions[submissionId];
    require(sub.status == Status.PENDING, "Not pending");

    // Verify caller is re-supplying the exact data the submitter committed to.
    bytes32 expected = keccak256(abi.encodePacked(
      keccak256(packedActions),
      keccak256(abi.encodePacked(r)),
      entryHash
    ));
    require(expected == sub.dataCommitment, "Data does not match commitment");

    // Decode checkpoint range + expected action count.
    uint256 startCp = sub.startCheckpointId;
    uint256 endCp = sub.endCheckpointId;
    uint256 numCp = endCp - startCp + 1;
    uint256 expectedActions = numCp * CHECKPOINT_INTERVAL;

    // Fold the hash chain over submitter's data, collecting checkpoint hashes.
    //
    // packedActions layout: [uint16 count][action0][action1]…
    // Each action is variable-length per CawActions._unpackAction:
    //   21 fixed + 1 rc + 1 ac + 4*rc + 8*ac + 2 + textLength
    // The on-chain hash chain uses keccak256(packedSlice) as actionHash
    // (CawActions.sol:592), so we MUST walk the same layout — fixed-width
    // slicing here used to silently produce garbage for any action whose
    // recipients/amounts/text was non-empty, slashing honest submitters.
    bytes32[] memory cpHashes = new bytes32[](numCp);
    bytes32 h = entryHash;
    uint256 pos = 2; // skip the uint16 count header
    for (uint256 i = 0; i < expectedActions; ) {
      uint256 nextPos = _actionSliceEnd(packedActions, pos);
      bytes32 actionHash = keccak256(packedActions[pos:nextPos]);
      h = keccak256(abi.encodePacked(h, r[i], actionHash));
      pos = nextPos;
      unchecked {
        uint256 nextI = i + 1;
        if (nextI % CHECKPOINT_INTERVAL == 0) {
          cpHashes[(nextI / CHECKPOINT_INTERVAL) - 1] = h;
        }
        i = nextI;
      }
    }
    require(pos == packedActions.length, "Trailing bytes in packedActions");

    // Rebuild the merkle root from checkpoint hashes (matches off-chain
    // buildCheckpointMerkleTree: double-hash leaves + sorted pairs).
    bytes32 computedRoot = _buildMerkleRoot(startCp, cpHashes);
    require(computedRoot != sub.merkleRoot, "Root matches, no fraud");

    // Same slash flow as resolveChallenge.
    address validator = sub.submitter;
    uint256 reward = stakes[validator];
    stakes[validator] = 0;

    uint256[] storage subIds = validatorSubmissions[validator];
    for (uint256 i = 0; i < subIds.length; ) {
      uint256 sid = subIds[i];
      Submission storage s = submissions[sid];
      if (s.status == Status.PENDING) {
        s.status = Status.SLASHED;
        for (uint256 cp = s.startCheckpointId; cp <= s.endCheckpointId; ) {
          checkpointClaimed[s.clientId][cp] = 0;
          unchecked { ++cp; }
        }
      }
      unchecked { ++i; }
    }
    pendingCount[validator] = 0;
    delete validatorSubmissions[validator];

    if (reward > 0) {
      (bool ok,) = msg.sender.call{value: reward}("");
      require(ok, "Transfer failed");
    }

    emit ValidatorSlashed(validator, msg.sender, submissionId, 0, reward);
  }

  /// @dev Compute the end offset of the action that starts at `pos` in
  ///      `packed`. Mirrors CawActions._unpackAction's position math:
  ///        21 fixed + 1 rc + 1 ac + 4*rc + 8*ac + 2 + textLength
  ///      Used by slashIncoherentRoot to walk variable-length actions with
  ///      the SAME boundaries the on-chain hash chain saw at submit time.
  function _actionSliceEnd(bytes calldata packed, uint256 pos)
    internal pure returns (uint256 nextPos)
  {
    // Defensive leading bounds — without this we'd be relying on EVM's
    // calldataload-past-end-returns-zero behavior for the rc/ac read. The
    // final require below catches it, but checking up-front makes the
    // invariant explicit and survives any future calldata-handling change.
    require(pos + 23 <= packed.length, "Action header overflow");

    uint256 rc;
    uint256 ac;
    uint256 textLength;
    assembly {
      let cdOff := add(packed.offset, pos)
      let w := calldataload(cdOff)
      // rc: 1 byte at bits [87..80]
      rc := and(shr(80, w), 0xFF)
      // ac: 1 byte at bits [79..72]
      ac := and(shr(72, w), 0xFF)
    }
    nextPos = pos + 23 + rc * 4 + ac * 8;
    require(nextPos + 2 <= packed.length, "Action body overflow");
    assembly {
      textLength := shr(240, calldataload(add(packed.offset, nextPos)))
    }
    nextPos += 2 + textLength;
    require(nextPos <= packed.length, "Action slice overflow");
  }

  /// @dev Rebuild merkle root from an ordered list of checkpoint hashes.
  ///      Leaves are double-hashed (OZ convention) and internal nodes are
  ///      sorted-pair keccak256.
  function _buildMerkleRoot(uint256 startCp, bytes32[] memory cpHashes) internal pure returns (bytes32) {
    uint256 n = cpHashes.length;
    bytes32[] memory layer = new bytes32[](n);
    for (uint256 i = 0; i < n; i++) {
      layer[i] = keccak256(bytes.concat(keccak256(abi.encode(startCp + i, cpHashes[i]))));
    }
    while (n > 1) {
      uint256 m = (n + 1) / 2;
      bytes32[] memory next = new bytes32[](m);
      for (uint256 i = 0; i < m; i++) {
        uint256 l = 2 * i;
        uint256 rIdx = l + 1;
        if (rIdx >= n) {
          // Odd-out leaf: bubble up unchanged. merkletreejs with
          // sortPairs has the same behavior when no pair exists.
          next[i] = layer[l];
        } else {
          bytes32 a = layer[l];
          bytes32 b = layer[rIdx];
          next[i] = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        }
      }
      layer = next;
      n = m;
    }
    return layer[0];
  }

  // ============================================
  // VIEW HELPERS
  // ============================================

  function isRangeAvailable(uint32 clientId, uint256 start, uint256 end) external view returns (bool) {
    for (uint256 cp = start; cp <= end; ) {
      if (checkpointClaimed[clientId][cp] != 0) return false;
      unchecked { ++cp; }
    }
    return true;
  }

  function getSubmission(uint256 submissionId) external view returns (
    address submitter, bytes32 merkleRoot, uint32 clientId,
    uint256 startCheckpointId, uint256 endCheckpointId,
    uint256 finalizedAt, Status status
  ) {
    Submission storage sub = submissions[submissionId];
    return (sub.submitter, sub.merkleRoot, sub.clientId,
            sub.startCheckpointId, sub.endCheckpointId, sub.finalizedAt, sub.status);
  }

  function getValidatorSubmissionCount(address validator) external view returns (uint256) {
    return validatorSubmissions[validator].length;
  }

  /// @notice Accept ETH deposits
  receive() external payable {
    stakes[msg.sender] += msg.value;
    emit Deposited(msg.sender, msg.value, stakes[msg.sender]);
  }
}
