// contracts/CawActionsArchiveOptimistic.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

/**
 * @title CawActionsArchiveOptimistic
 * @notice Deployed on archive chains (L2b, L3, etc). Receives action data directly
 *         from validators with a stake. Data is considered valid after a 2-day
 *         challenge window. Challenges are relayed via LayerZero from L2 and carry
 *         the ground-truth checkpoint hash from CawActions.
 *
 * @dev Trust model:
 *   - Submitter posts (packedActions, r[], merkleRoot) + stake.
 *   - merkleRoot commits to all checkpoint hashes via a merkle tree.
 *   - Checkpoint hashes commit to (prevHash, r, actionData) via the hash chain.
 *   - Any validator can verify off-chain and challenge via CawChallengeRelay on L2.
 *   - After CHALLENGE_PERIOD with no successful challenge, data is considered canonical.
 *   - If challenged: submitter loses stake, data is invalidated, replacement welcome.
 *
 * Security assumptions:
 *   - At least one honest validator monitors submissions within 2 days.
 *   - LZ delivers challenge messages correctly (same trust as current system).
 *   - L2 checkpoint hashes are final (L2 has ~minute finality, window is 2 days).
 */
contract CawActionsArchiveOptimistic is Ownable, OApp {

  // ============================================
  // TYPES
  // ============================================

  enum Status { PENDING, FINALIZED, SLASHED }

  struct Submission {
    address submitter;
    uint96  stakeAmount;       // packed with submitter in one slot
    bytes32 merkleRoot;
    uint32  clientId;
    uint64  startCheckpointId;
    uint64  endCheckpointId;
    uint64  finalizedAt;       // block.timestamp + CHALLENGE_PERIOD
    Status  status;
  }

  // ============================================
  // CONSTANTS
  // ============================================

  uint256 public constant CHALLENGE_PERIOD = 2 days;
  uint256 public constant MIN_STAKE = 0.001 ether;
  uint256 public constant MAX_STAKE = 1 ether;
  uint256 public constant CHECKPOINT_INTERVAL = 32;
  uint256 public constant MAX_CHECKPOINTS_PER_SUBMISSION = 256;

  // ============================================
  // STATE
  // ============================================

  uint256 public nextSubmissionId = 1;
  mapping(uint256 => Submission) public submissions;

  /// @notice clientId => checkpointId => submissionId that covers it (pending or finalized)
  mapping(uint32 => mapping(uint256 => uint256)) public checkpointClaimed;

  /// @notice submissionId => checkpointId => correctHash (delivered via LZ)
  mapping(uint256 => mapping(uint256 => bytes32)) public challengeHash;

  /// @notice Whether a challenge hash has been delivered for a (submission, checkpoint)
  mapping(uint256 => mapping(uint256 => bool)) public challengeDelivered;

  // ============================================
  // EVENTS
  // ============================================

  event SubmissionCreated(
    uint256 indexed submissionId,
    address indexed submitter,
    uint32 indexed clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes32 merkleRoot,
    uint256 stakeAmount
  );

  /// @notice Emitted with the full packed action data for indexers to reconstruct.
  ///         The data is NOT stored in contract state — only in event logs.
  event ActionsArchived(
    uint256 indexed submissionId,
    uint32 indexed clientId,
    bytes packedActions,
    bytes32[] r
  );

  event SubmissionFinalized(uint256 indexed submissionId);

  event SubmissionSlashed(
    uint256 indexed submissionId,
    address indexed challenger,
    uint256 checkpointId,
    uint256 reward
  );

  event StakeWithdrawn(uint256 indexed submissionId, address indexed submitter, uint256 amount);

  event ChallengeHashDelivered(
    uint256 indexed submissionId,
    uint256 checkpointId,
    bytes32 correctHash
  );

  // ============================================
  // CONSTRUCTOR
  // ============================================

  /// @param _endpoint LayerZero endpoint (for receiving challenge proofs)
  constructor(address _endpoint) OApp(_endpoint, msg.sender) {}

  // ============================================
  // SUBMISSION
  // ============================================

  /// @notice Submit a batch of checkpoint data for archival. Submitter must stake
  ///         at least MIN_STAKE as a bond. Data becomes final after CHALLENGE_PERIOD.
  /// @param clientId The client whose actions are being archived
  /// @param startCheckpointId First checkpoint in the range (inclusive)
  /// @param endCheckpointId Last checkpoint in the range (inclusive)
  /// @param packedActions Packed action bytes (same format as CawActions.processActions)
  /// @param r Signature r values (CHECKPOINT_INTERVAL * numCheckpoints items)
  /// @param merkleRoot Merkle root over checkpoint hash leaves:
  ///        leaf[i] = keccak256(abi.encodePacked(checkpointId_i, checkpointHash_i))
  function submitReplication(
    uint32 clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    bytes calldata packedActions,
    bytes32[] calldata r,
    bytes32 merkleRoot
  ) external payable {
    require(msg.value >= MIN_STAKE && msg.value <= MAX_STAKE, "Invalid stake");
    require(startCheckpointId > 0, "Invalid start");
    require(endCheckpointId >= startCheckpointId, "Invalid range");

    uint256 numCheckpoints = endCheckpointId - startCheckpointId + 1;
    require(numCheckpoints <= MAX_CHECKPOINTS_PER_SUBMISSION, "Too many checkpoints");

    uint256 expectedActions = numCheckpoints * CHECKPOINT_INTERVAL;
    // Verify action count from packed header
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
    require(actionCount == expectedActions, "Action count mismatch");
    require(r.length == expectedActions, "r array length mismatch");
    require(merkleRoot != bytes32(0), "Empty merkle root");

    // Ensure no checkpoint in the range is already claimed (pending or finalized)
    for (uint256 cp = startCheckpointId; cp <= endCheckpointId; ) {
      require(checkpointClaimed[clientId][cp] == 0, "Checkpoint already claimed");
      unchecked { ++cp; }
    }

    uint256 submissionId = nextSubmissionId++;

    submissions[submissionId] = Submission({
      submitter: msg.sender,
      stakeAmount: uint96(msg.value),
      merkleRoot: merkleRoot,
      clientId: clientId,
      startCheckpointId: uint64(startCheckpointId),
      endCheckpointId: uint64(endCheckpointId),
      finalizedAt: uint64(block.timestamp + CHALLENGE_PERIOD),
      status: Status.PENDING
    });

    // Claim all checkpoints in the range
    for (uint256 cp = startCheckpointId; cp <= endCheckpointId; ) {
      checkpointClaimed[clientId][cp] = submissionId;
      unchecked { ++cp; }
    }

    emit SubmissionCreated(submissionId, msg.sender, clientId, startCheckpointId, endCheckpointId, merkleRoot, msg.value);
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
    emit SubmissionFinalized(submissionId);
  }

  /// @notice Withdraw stake from a finalized submission. Only the submitter.
  function withdrawStake(uint256 submissionId) external {
    Submission storage sub = submissions[submissionId];
    require(sub.status == Status.FINALIZED, "Not finalized");
    require(msg.sender == sub.submitter, "Not submitter");

    uint256 amount = sub.stakeAmount;
    require(amount > 0, "Already withdrawn");
    sub.stakeAmount = 0;

    (bool ok,) = msg.sender.call{value: amount}("");
    require(ok, "Transfer failed");

    emit StakeWithdrawn(submissionId, msg.sender, amount);
  }

  // ============================================
  // CHALLENGE — LZ RECEIVE
  // ============================================

  /// @notice Receives a challenge proof from CawChallengeRelay via LayerZero.
  ///         Stores the correct checkpoint hash for later resolution.
  /// @dev The payload is: abi.encode(submissionId, clientId, checkpointId, correctHash)
  ///      The hash is trusted because it comes from a registered LZ peer that reads
  ///      directly from CawActions on L2.
  function _lzReceive(
    Origin calldata,
    bytes32,
    bytes calldata payload,
    address,
    bytes calldata
  ) internal override {
    (uint256 submissionId, uint32 clientId, uint256 checkpointId, bytes32 correctHash) =
      abi.decode(payload, (uint256, uint32, uint256, bytes32));

    // Only store if submission is pending and clientId matches
    Submission storage sub = submissions[submissionId];
    if (sub.status != Status.PENDING) return; // silent skip — already finalized or slashed
    if (sub.clientId != clientId) return;
    if (checkpointId < sub.startCheckpointId || checkpointId > sub.endCheckpointId) return;

    challengeHash[submissionId][checkpointId] = correctHash;
    challengeDelivered[submissionId][checkpointId] = true;

    emit ChallengeHashDelivered(submissionId, checkpointId, correctHash);
  }

  // ============================================
  // CHALLENGE — RESOLUTION
  // ============================================

  /// @notice Resolve a challenge by proving the submitter's claimed hash doesn't
  ///         match the correct hash delivered via LZ. Anyone can call.
  /// @param submissionId The submission to challenge
  /// @param checkpointId The checkpoint within the submission to dispute
  /// @param claimedHash The hash the submitter committed to for this checkpoint
  /// @param merkleProof Proof that claimedHash is in the submission's merkle tree
  function resolveChallenge(
    uint256 submissionId,
    uint256 checkpointId,
    bytes32 claimedHash,
    bytes32[] calldata merkleProof
  ) external {
    Submission storage sub = submissions[submissionId];
    require(sub.status == Status.PENDING, "Not pending");
    require(challengeDelivered[submissionId][checkpointId], "No challenge hash delivered");

    // Verify the claimed hash is what the submitter committed to via merkle proof
    bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(checkpointId, claimedHash))));
    require(MerkleProof.verify(merkleProof, sub.merkleRoot, leaf), "Invalid merkle proof");

    // The correct hash from L2 (delivered via LZ) must differ from what was claimed
    bytes32 correctHash = challengeHash[submissionId][checkpointId];
    require(correctHash != claimedHash, "Hashes match, no fraud");

    // Slash: mark submission invalid, release checkpoint claims, pay challenger
    sub.status = Status.SLASHED;
    uint256 reward = sub.stakeAmount;
    sub.stakeAmount = 0;

    // Release checkpoint claims so someone else can resubmit
    for (uint256 cp = sub.startCheckpointId; cp <= sub.endCheckpointId; ) {
      checkpointClaimed[sub.clientId][cp] = 0;
      unchecked { ++cp; }
    }

    (bool ok,) = msg.sender.call{value: reward}("");
    require(ok, "Transfer failed");

    emit SubmissionSlashed(submissionId, msg.sender, checkpointId, reward);
  }

  // ============================================
  // VIEW HELPERS
  // ============================================

  /// @notice Check if a checkpoint range is available for submission
  function isRangeAvailable(uint32 clientId, uint256 start, uint256 end) external view returns (bool) {
    for (uint256 cp = start; cp <= end; ) {
      if (checkpointClaimed[clientId][cp] != 0) return false;
      unchecked { ++cp; }
    }
    return true;
  }

  /// @notice Get submission details
  function getSubmission(uint256 submissionId) external view returns (
    address submitter,
    uint256 stakeAmount,
    bytes32 merkleRoot,
    uint32 clientId,
    uint256 startCheckpointId,
    uint256 endCheckpointId,
    uint256 finalizedAt,
    Status status
  ) {
    Submission storage sub = submissions[submissionId];
    return (sub.submitter, sub.stakeAmount, sub.merkleRoot, sub.clientId,
            sub.startCheckpointId, sub.endCheckpointId, sub.finalizedAt, sub.status);
  }

  /// @notice Required to receive ETH stakes
  receive() external payable {}
}
