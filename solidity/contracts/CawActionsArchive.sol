// contracts/CawActionsArchive.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

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
contract CawActionsArchive is Ownable, ReentrancyGuard, OApp {

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

  event ActionsArchived(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    bytes packedActions,
    bytes32[] r
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
    // exact bytes that were submitted.
    bytes32 dataCommitment = keccak256(abi.encodePacked(
      keccak256(packedActions),
      keccak256(abi.encodePacked(r)),
      entryHash
    ));

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
    emit ActionsArchived(submissionId, clientId, packedActions, r);
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

  /// @dev Receives correct checkpoint hash from CawChallengeRelay via LZ.
  ///      The default OAppReceiver peer check (msg.sender == endpoint, and
  ///      origin.sender == peers[srcEid]) restricts this to the canonical relay
  ///      the archive owner peered at deploy time.
  function _lzReceive(
    Origin calldata,
    bytes32,
    bytes calldata payload,
    address,
    bytes calldata
  ) internal override {
    (uint256 submissionId, uint32 clientId, uint256 checkpointId, bytes32 correctHash) =
      abi.decode(payload, (uint256, uint32, uint256, bytes32));

    Submission storage sub = submissions[submissionId];
    if (sub.status != Status.PENDING) return;
    if (sub.clientId != clientId) return;
    if (checkpointId < sub.startCheckpointId || checkpointId > sub.endCheckpointId) return;

    challengeHash[submissionId][checkpointId] = correctHash;
    challengeDelivered[submissionId][checkpointId] = true;

    emit ChallengeHashDelivered(submissionId, checkpointId, correctHash);
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
    bytes32[] memory cpHashes = new bytes32[](numCp);
    bytes32 h = entryHash;
    for (uint256 i = 0; i < expectedActions; ) {
      // packedActions layout: [uint16 count][action0 25B][action1 25B]...
      // action slice for index i lives at offset 2 + i*25, length 25.
      bytes calldata slice = packedActions[2 + i * 25 : 2 + i * 25 + 25];
      bytes32 actionHash = keccak256(slice);
      h = keccak256(abi.encodePacked(h, r[i], actionHash));
      unchecked {
        uint256 nextI = i + 1;
        if (nextI % CHECKPOINT_INTERVAL == 0) {
          cpHashes[(nextI / CHECKPOINT_INTERVAL) - 1] = h;
        }
        i = nextI;
      }
    }

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
