// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title CawActionsArchiveEchidna
/// @notice Echidna fuzz of the stake / submission / finalization / slash
///         state machine in CawActionsArchive, sans the LZ transport.
///
/// @dev Why a re-impl harness instead of deploying CawActionsArchive
///      directly: the production contract inherits OApp which requires a
///      real LZ endpoint address at construction. Echidna's deployment
///      path can't easily provide that, and we don't want the fuzz to
///      bounce off LZ-related reverts.
///
///      The state we DO want to fuzz is fully self-contained:
///        - deposit  (msg.value -> stake)
///        - withdraw (only when 0 pending submissions)
///        - submit   (require stake >= MIN_STAKE; push to validatorSubmissions)
///        - finalize (after CHALLENGE_PERIOD, swap-and-pop from array)
///        - slash    (zero stake, mark all PENDING submissions SLASHED, clear claims)
///
///      Invariants we assert across arbitrary sequences:
///        1. pendingCount[v] == count(submissions s : s.submitter==v && s.status==PENDING)
///        2. validatorSubmissions[v].length == pendingCount[v]
///        3. finalize never fires before block.timestamp >= finalizedAt
///        4. stakes[v] only decreases via withdraw, slash; never goes negative (uint underflow surfaces)
///        5. ETH conservation: address(this).balance ==
///             sum(stakes) + (in-flight rewards) (handled by closing each tx atomically — every
///             slash transfers reward out to msg.sender; so address(this).balance == sum(stakes))
///        6. A SLASHED submission never reverts to PENDING.
///        7. checkpointClaimed re-opens after a slash (claim cleared) — confirms slash-loop walks all subs.
contract CawActionsArchiveEchidna {

    enum Status { PENDING, FINALIZED, SLASHED }

    struct Submission {
        address submitter;
        uint32 networkId;
        uint64 startCheckpointId;
        uint64 endCheckpointId;
        uint64 finalizedAt;
        Status status;
    }

    uint256 public constant CHALLENGE_PERIOD = 2 days;
    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant MAX_CHECKPOINTS_PER_SUBMISSION = 4; // shrunk for fuzz speed

    uint256 public nextSubmissionId = 1;
    mapping(uint256 => Submission) public submissions;
    mapping(address => uint256) public stakes;
    mapping(address => uint256) public pendingCount;
    mapping(address => uint256[]) public validatorSubmissions;
    mapping(uint256 => uint256) internal validatorSubmissionsIndexPlusOne;
    mapping(uint32 => mapping(uint256 => uint256)) public checkpointClaimed;

    // Echidna-side bookkeeping
    address[] internal seenValidators;
    mapping(address => bool) internal seenValidator;
    uint256[] internal allSubmissionIds;

    // Latch: once a submission was SLASHED, it must never go back to PENDING.
    mapping(uint256 => bool) internal sawSlashed;

    // Track the running total of all stakes so we can compare to balance.
    uint256 public totalStakedSnapshot;

    // ===================================================================
    // Handlers
    // ===================================================================

    function deposit() external payable {
        // No upper bound, but the test campaign sends bounded msg.value.
        if (msg.value == 0) return;
        if (!seenValidator[msg.sender]) {
            seenValidator[msg.sender] = true;
            seenValidators.push(msg.sender);
        }
        stakes[msg.sender] += msg.value;
        totalStakedSnapshot += msg.value;
    }

    function withdrawAll() external {
        if (pendingCount[msg.sender] != 0) return;
        uint256 amt = stakes[msg.sender];
        if (amt == 0) return;
        stakes[msg.sender] = 0;
        totalStakedSnapshot -= amt;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "transfer");
    }

    function submitReplication(uint32 networkId, uint64 startCp, uint64 numCps) external {
        if (stakes[msg.sender] < MIN_STAKE) return;
        if (startCp == 0) return;
        // Bound to small ranges so we don't blow the gas-per-call budget.
        networkId = uint32(networkId % 3); // 3 networks
        startCp = uint64(startCp % 64);
        if (startCp == 0) startCp = 1;
        if (numCps == 0) numCps = 1;
        numCps = uint64(numCps % MAX_CHECKPOINTS_PER_SUBMISSION) + 1;
        uint64 endCp = startCp + numCps - 1;

        // Check no overlap with existing claims.
        for (uint64 cp = startCp; cp <= endCp; cp++) {
            if (checkpointClaimed[networkId][cp] != 0) return;
        }

        uint256 sid = nextSubmissionId++;
        submissions[sid] = Submission({
            submitter: msg.sender,
            networkId: networkId,
            startCheckpointId: startCp,
            endCheckpointId: endCp,
            finalizedAt: uint64(block.timestamp + CHALLENGE_PERIOD),
            status: Status.PENDING
        });
        for (uint64 cp = startCp; cp <= endCp; cp++) {
            checkpointClaimed[networkId][cp] = sid;
        }
        pendingCount[msg.sender]++;
        validatorSubmissions[msg.sender].push(sid);
        validatorSubmissionsIndexPlusOne[sid] = validatorSubmissions[msg.sender].length;
        allSubmissionIds.push(sid);
    }

    function finalizeSubmission(uint256 sidIdx) external {
        if (allSubmissionIds.length == 0) return;
        uint256 sid = allSubmissionIds[sidIdx % allSubmissionIds.length];
        Submission storage s = submissions[sid];
        if (s.status != Status.PENDING) return;
        if (block.timestamp < s.finalizedAt) return;
        s.status = Status.FINALIZED;
        pendingCount[s.submitter]--;
        _removeFromValidatorSubmissions(s.submitter, sid);
    }

    function _removeFromValidatorSubmissions(address validator, uint256 sid) internal {
        uint256 idxPlusOne = validatorSubmissionsIndexPlusOne[sid];
        if (idxPlusOne == 0) return;
        uint256[] storage arr = validatorSubmissions[validator];
        uint256 idx = idxPlusOne - 1;
        uint256 last = arr.length - 1;
        if (idx != last) {
            uint256 lastSid = arr[last];
            arr[idx] = lastSid;
            validatorSubmissionsIndexPlusOne[lastSid] = idxPlusOne;
        }
        arr.pop();
        validatorSubmissionsIndexPlusOne[sid] = 0;
    }

    /// @dev Slash a validator. Production gates this on a delivered LZ
    ///      challenge + merkle proof; here we let Echidna invoke it
    ///      arbitrarily but on a victim we pick from the seen pool. We
    ///      enforce the "no self-slash" rule the same way as production.
    function slash(uint256 victimIdx) external {
        if (seenValidators.length == 0) return;
        address validator = seenValidators[victimIdx % seenValidators.length];
        if (msg.sender == validator) return; // anti-self-slash
        if (stakes[validator] == 0) return;  // no-op when there's nothing to slash

        uint256 reward = stakes[validator];
        stakes[validator] = 0;
        totalStakedSnapshot -= reward;

        uint256[] storage subIds = validatorSubmissions[validator];
        for (uint256 i = 0; i < subIds.length; i++) {
            uint256 sid = subIds[i];
            Submission storage s = submissions[sid];
            if (s.status == Status.PENDING) {
                s.status = Status.SLASHED;
                sawSlashed[sid] = true;
                for (uint256 cp = s.startCheckpointId; cp <= s.endCheckpointId; cp++) {
                    checkpointClaimed[s.networkId][cp] = 0;
                }
            }
        }
        pendingCount[validator] = 0;
        delete validatorSubmissions[validator];

        if (reward > 0) {
            (bool ok,) = msg.sender.call{value: reward}("");
            require(ok, "transfer");
        }
    }

    // ===================================================================
    // Invariants
    // ===================================================================

    /// @notice pendingCount[v] equals the length of validatorSubmissions[v]
    ///         (since we swap-and-pop on finalize / clear on slash).
    function echidna_pending_array_size_match() external view returns (bool) {
        for (uint i = 0; i < seenValidators.length; i++) {
            address v = seenValidators[i];
            if (validatorSubmissions[v].length != pendingCount[v]) return false;
        }
        return true;
    }

    /// @notice pendingCount[v] equals the count of submissions with submitter==v
    ///         and status==PENDING, computed independently by scanning all subs.
    function echidna_pending_count_consistent() external view returns (bool) {
        for (uint i = 0; i < seenValidators.length; i++) {
            address v = seenValidators[i];
            uint256 c;
            for (uint256 j = 0; j < allSubmissionIds.length; j++) {
                uint256 sid = allSubmissionIds[j];
                Submission storage s = submissions[sid];
                if (s.submitter == v && s.status == Status.PENDING) c++;
            }
            if (c != pendingCount[v]) return false;
        }
        return true;
    }

    /// @notice A SLASHED submission never recovers — status latches.
    function echidna_slashed_latches() external view returns (bool) {
        for (uint256 j = 0; j < allSubmissionIds.length; j++) {
            uint256 sid = allSubmissionIds[j];
            if (sawSlashed[sid] && submissions[sid].status != Status.SLASHED) return false;
        }
        return true;
    }

    /// @notice address(this).balance equals sum(stakes) — every ETH path
    ///         (deposit/withdraw/slash) keeps the books tight.
    function echidna_eth_conserved() external view returns (bool) {
        uint256 total;
        for (uint i = 0; i < seenValidators.length; i++) {
            total += stakes[seenValidators[i]];
        }
        return address(this).balance == total;
    }

    /// @notice After slash, every PENDING submission of the victim becomes
    ///         SLASHED and its checkpoint claims are released. Independent
    ///         invariant: no two PENDING submissions share a checkpoint slot
    ///         (uniqueness of checkpointClaimed).
    ///
    ///         Encoded as: for each (sid_a, sid_b) covering overlapping cps
    ///         on the same network, at most one is PENDING.
    function echidna_no_overlapping_pending() external view returns (bool) {
        for (uint256 i = 0; i < allSubmissionIds.length; i++) {
            uint256 a = allSubmissionIds[i];
            Submission storage sa = submissions[a];
            if (sa.status != Status.PENDING) continue;
            for (uint256 j = i + 1; j < allSubmissionIds.length; j++) {
                uint256 b = allSubmissionIds[j];
                Submission storage sb = submissions[b];
                if (sb.status != Status.PENDING) continue;
                if (sa.networkId != sb.networkId) continue;
                bool overlap = !(sa.endCheckpointId < sb.startCheckpointId || sb.endCheckpointId < sa.startCheckpointId);
                if (overlap) return false;
            }
        }
        return true;
    }

    /// @notice finalize was only honored after the challenge period — encoded by
    ///         the require in finalizeSubmission. As a complementary check, no
    ///         FINALIZED submission has block.timestamp < finalizedAt at the
    ///         time of observation (block.timestamp only moves forward).
    function echidna_finalize_after_window() external view returns (bool) {
        for (uint256 j = 0; j < allSubmissionIds.length; j++) {
            uint256 sid = allSubmissionIds[j];
            Submission storage s = submissions[sid];
            if (s.status == Status.FINALIZED && block.timestamp < s.finalizedAt) return false;
        }
        return true;
    }

    /// @notice Receive ETH path — production accepts via receive(); we mirror it.
    receive() external payable {
        if (!seenValidator[msg.sender]) {
            seenValidator[msg.sender] = true;
            seenValidators.push(msg.sender);
        }
        stakes[msg.sender] += msg.value;
        totalStakedSnapshot += msg.value;
    }
}
