// contracts/CawActionsArchiveOptimistic.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

/**
 * @title CawActionsArchiveOptimistic
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
 *   - Challenge proofs arrive via LZ from CawChallengeRelay (reads CawActions on L2).
 *   - At least one honest validator must monitor within CHALLENGE_PERIOD.
 */
contract CawActionsArchiveOptimistic is Ownable, OApp {

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
  function withdraw(uint256 amount) external {
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
  function submitReplication(
    uint32 clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes calldata packedActions,
    bytes32[] calldata r,
    bytes32 merkleRoot
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

    submissions[submissionId] = Submission({
      submitter: msg.sender,
      merkleRoot: merkleRoot,
      clientId: clientId,
      startCheckpointId: uint64(startCheckpointId),
      endCheckpointId: uint64(endCheckpointId),
      finalizedAt: uint64(block.timestamp + CHALLENGE_PERIOD),
      status: Status.PENDING
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
  ) external {
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

    // Pay the challenger
    if (reward > 0) {
      (bool ok,) = msg.sender.call{value: reward}("");
      require(ok, "Transfer failed");
    }

    emit ValidatorSlashed(validator, msg.sender, submissionId, checkpointId, reward);
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
