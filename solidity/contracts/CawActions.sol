// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./CawNameL2.sol";
import { CawActionsReplicator, ReplicationDestination } from "./CawActionsReplicator.sol";

import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Ownable {
  /// @notice Replicator for archiving actions to other chains (can only be set once)
  CawActionsReplicator public replicator;
  enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, OTHER }

  struct ActionData {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 receiverCawonce;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint64[] amounts;  // Whole CAW tokens (not wei) - multiplied by 10^18 on-chain
    string text;
  }

  struct MultiActionData {
    ActionData[] actions;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
  }

  bytes32 public immutable eip712DomainHash;

  // Checkpointing for verifiable migration to other chains (per-client)
  // Every 256 actions per client, we store the client's currentHash. This allows
  // historical actions to be replayed and verified in chunks during migration,
  // without storing all r values on-chain. Migration submits 256 r values + a batch
  // of actions, verifies the r values chain to the checkpoint, and that actions
  // match their r values. Each client's actions are independent.
  mapping(uint32 => uint256) public clientActionCount;
  mapping(uint32 => bytes32) public clientCurrentHash;
  mapping(uint32 => mapping(uint256 => bytes32)) public clientHashAtCheckpoint;

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  /// @notice Tracks cumulative spending (whole CAW tokens) per session key (by owner address)
  mapping(address => mapping(address => uint256)) public sessionSpent;

  event ActionsProcessed(ActionData[] actions);
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);
  event ReplicatorSet(address replicator);

  CawNameL2 public immutable cawName;
  CawActions public immutable externalSelf;

  // Precomputed type hashes for EIP712
  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
    "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint64[] amounts,string text)"
  );

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    externalSelf = CawActions(this);
    cawName = CawNameL2(_cawNames);
  }

  /// @notice Set the replicator address (can only be called once by owner, then ownership is renounced)
  /// @param _replicator The address of the CawActionsReplicator contract
  function setReplicator(address _replicator) external onlyOwner {
    require(address(replicator) == address(0), "Replicator already set");
    require(_replicator != address(0), "Invalid replicator address");
    replicator = CawActionsReplicator(_replicator);
    emit ReplicatorSet(_replicator);
    renounceOwnership();
  }

  function processAction(uint32 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    _processAction(validatorId, action, v, r, s);
  }

  function _processAction(uint32 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) internal {
    require(!isCawonceUsed(action.senderId, action.cawonce), "Cawonce already used");
    require(cawName.authenticated(action.clientId, action.senderId), "User has not authenticated with this client");

    (address signer, bool isSessionKey) = verifySignature(v, r, s, action);

    // Fixed protocol costs per action type (in whole CAW tokens)
    uint256 actionCost;
    if (action.actionType == ActionType.CAW) {
      require(bytes(action.text).length <= 420, "Text exceeds 420 characters");
      cawName.spendAndDistributeTokens(action.senderId, 5000, 5000);
      actionCost = 5000;
    } else if (action.actionType == ActionType.LIKE) {
      cawName.spendDistributeAndAddTokensToBalance(action.senderId, 2000, 400, action.receiverId, 1600);
      actionCost = 2000;
    } else if (action.actionType == ActionType.RECAW) {
      cawName.spendDistributeAndAddTokensToBalance(action.senderId, 4000, 2000, action.receiverId, 2000);
      actionCost = 4000;
    } else if (action.actionType == ActionType.FOLLOW) {
      require(action.senderId != action.receiverId, "Cannot follow yourself");
      cawName.spendDistributeAndAddTokensToBalance(action.senderId, 30000, 6000, action.receiverId, 24000);
      actionCost = 30000;
    } else if (action.actionType == ActionType.WITHDRAW)
      cawName.withdraw(action.senderId, uint256(action.amounts[0]) * 10**18);
    else if ( action.actionType != ActionType.UNLIKE &&
        action.actionType != ActionType.UNFOLLOW &&
        action.actionType != ActionType.OTHER)
      revert("Invalid action type");

    // Add distributeAmounts costs (tips, validator fees — all in whole tokens)
    uint256 distributeCost = distributeAmounts(validatorId, action);
    actionCost += distributeCost;

    // Enforce session spend limit
    if (isSessionKey && actionCost > 0) {
      address owner = cawName.ownerOf(action.senderId);
      (,, uint256 spendLimit) = cawName.sessions(owner, signer);
      if (spendLimit > 0) {
        sessionSpent[owner][signer] += actionCost;
        require(sessionSpent[owner][signer] <= spendLimit, "Session spend limit exceeded");
      }
    }

    useCawonce(action.senderId, action.cawonce);

    // Per-client hash and checkpointing (for client-specific migration)
    uint32 clientId = action.clientId;

    clientCurrentHash[clientId] = keccak256(abi.encodePacked(clientCurrentHash[clientId], r));
    clientActionCount[clientId]++;

    if (clientActionCount[clientId] % 256 == 0)
      clientHashAtCheckpoint[clientId][clientActionCount[clientId] / 256] = clientCurrentHash[clientId];
  }

  /// @return totalWholeTokens Total whole CAW tokens spent via distributeAmounts
  function distributeAmounts(uint32 validatorId, ActionData calldata action) internal returns (uint256 totalWholeTokens) {
    uint256 numRecipients = action.recipients.length;
    uint256 numAmounts = action.amounts.length;

    if (numAmounts != numRecipients)
      require(numAmounts == numRecipients + 1, "Amounts and recipients mismatch");

    if (numRecipients == 0 && numAmounts == 0) return 0;

    bool isWithdrawal = action.actionType == ActionType.WITHDRAW;
    uint256 startIndex = isWithdrawal ? 1 : 0;

    // Convert from whole CAW tokens to wei (multiply by 10^18)
    uint256 amountTotal = uint256(action.amounts[numAmounts - 1]) * 10**18;
    totalWholeTokens = uint256(action.amounts[numAmounts - 1]);

    for (uint256 i = startIndex; i < numRecipients; ) {
      uint256 amountWei = uint256(action.amounts[i]) * 10**18;
      cawName.addToBalance(action.recipients[i], amountWei);
      amountTotal += amountWei;
      totalWholeTokens += uint256(action.amounts[i]);
      unchecked { ++i; }
    }

    cawName.spendAndDistribute(action.senderId, amountTotal, 0);
    cawName.addToBalance(validatorId, uint256(action.amounts[numAmounts - 1]) * 10**18);
  }

  /// @notice Verify action signature. Returns the signer and whether it was a session key.
  function verifySignature(
    uint8 v,
    bytes32 r,
    bytes32 s,
    ActionData calldata data
  ) public view returns (address signer, bool isSessionKey) {
    bytes32 structHash = keccak256(
      abi.encode(
        ACTIONDATA_TYPEHASH,
        data.actionType,
        data.senderId,
        data.receiverId,
        data.receiverCawonce,
        data.clientId,
        data.cawonce,
        keccak256(abi.encodePacked(data.recipients)),
        keccak256(abi.encodePacked(data.amounts)),
        keccak256(bytes(data.text))
      )
    );

    signer = getSigner(structHash, v, r, s);
    require(signer != address(0), "Invalid signature");

    // Direct owner signature — pass immediately
    address owner = cawName.ownerOf(data.senderId);
    if (signer == owner) return (signer, false);

    // Session key fallback: look up delegation by the token's current owner
    (uint64 expiry, uint8 scopeBitmap,) = cawName.sessions(owner, signer);
    require(expiry > block.timestamp, "Session expired or not found");
    require((scopeBitmap & (1 << uint8(data.actionType))) != 0, "Action not in session scope");
    return (signer, true);
  }

  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce >> 8; // Divide by 256
    uint256 bit = cawonce & 0xff; // Modulo 256
    usedCawonce[senderId][word] |= (1 << bit);
    if (usedCawonce[senderId][word] == type(uint256).max) {
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
    uint256 word = cawonce >> 8; // Divide by 256
    uint256 bit = cawonce & 0xff; // Modulo 256
    return (usedCawonce[senderId][word] & (1 << bit)) != 0;
  }

  function getSigner(
    bytes32 structHash,
    uint8 v,
    bytes32 r,
    bytes32 s
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

  // This function can technically be used to process actions,
  // but by design it will consume more gas, as it will not
  // short circuit fail if an action is rejected.
  //
  // The actual intention of this function is to be used with eth_call,
  // which does not execute or change state on the block chain.
  //
  // The returned actions from this using eth_call will have been
  // fully verified and should be able to be processed successfully
  // via processActions.
  //
  // The second return object will be an array of error messages
  // that correspond with the failure reasons for each failed action.
  function safeProcessActions(
    uint32 validatorId,
    MultiActionData calldata data,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount,
    uint256 replicationLzTokenAmount
  ) external payable returns (ActionData[] memory successfulActions, string[] memory rejections){
    uint256 actionsLength = data.actions.length;
    require(actionsLength <= 256, "Cannot process more than 256 actions");
    require(actionsLength > 0, "No actions");
    _requireSingleClient(data);

    uint16 successCount;
    uint16 withdrawCount;
    uint256 successBitmap = 0;
    uint256 withdrawBitmap = 0;
    rejections = new string[](actionsLength);


    for (uint16 i = 0; i < actionsLength; ) {
      try CawActions(this).processAction(validatorId, data.actions[i], data.v[i], data.r[i], data.s[i]) {
        successBitmap |= (1 << i);
        if (data.actions[i].actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);
          unchecked { ++withdrawCount; }
        }
        unchecked { ++successCount; }
      } catch Error(string memory reason) {
        rejections[i] = reason;
        emit ActionRejected(data.actions[i].senderId, data.actions[i].cawonce, reason);
      } catch (bytes memory) {
        rejections[i] = "Low-level exception";
        emit ActionRejected(data.actions[i].senderId, data.actions[i].cawonce, "Low-level exception");
      }
      unchecked { ++i; }
    }

    successfulActions = new ActionData[](successCount);
    if (successCount > 0) {
      uint16 index = 0;
      for (uint16 i = 0; i < actionsLength; ) {
        if ((successBitmap & (1 << i)) != 0) {
          successfulActions[index] = data.actions[i];
          unchecked { ++index; }
        }
        unchecked { ++i; }
      }
      emit ActionsProcessed(data.actions);
    }

    // Handle withdrawals
    setWithdrawable(withdrawBitmap, withdrawCount, data.actions, withdrawLzTokenAmount, withdrawFee);

    // Replicate only successful actions
    if (successCount > 0) {
      replicateFiltered(data, successBitmap, successCount, msg.value - withdrawFee, replicationLzTokenAmount);
    }

    return (successfulActions, rejections);
  }

  // Note: processActions and safeProcessActions are intentionally permissionless.
  // Any address can submit valid signed actions and specify their own validatorId
  // to collect validator fees. This is by design — the protocol allows anyone to
  // run a validator and earn fees for processing actions.
  function processActions(
    uint32 validatorId,
    MultiActionData calldata data,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount,
    uint256 replicationLzTokenAmount
  ) external payable {
    uint256 actionsLength = data.actions.length;
    require(actionsLength <= 256, "Cannot process more than 256 actions");
    require(actionsLength > 0, "No actions");
    _requireSingleClient(data);

    uint16 withdrawCount;
    uint256 withdrawBitmap = 0;

    for (uint16 i = 0; i < actionsLength; ) {
      _processAction(validatorId, data.actions[i], data.v[i], data.r[i], data.s[i]);
        if (data.actions[i].actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);
          unchecked { ++withdrawCount; }
        }
      unchecked { ++i; }
    }
    emit ActionsProcessed(data.actions);

    // Handle withdrawals
    setWithdrawable(withdrawBitmap, withdrawCount, data.actions, withdrawLzTokenAmount, withdrawFee);

    // Replicate actions
    replicate(data, msg.value - withdrawFee, replicationLzTokenAmount);
  }

  /// @dev Enforces that all actions in a batch belong to the same client.
  function _requireSingleClient(MultiActionData calldata data) internal pure {
    uint32 clientId = data.actions[0].clientId;
    for (uint256 i = 1; i < data.actions.length; i++)
      require(data.actions[i].clientId == clientId, "All actions must belong to the same client");
  }

  /**
   * @notice Replicates all actions in the batch to archive chains.
   * @dev Single-client enforced at processActions/safeProcessActions entry point.
   */
  function replicate(
    MultiActionData calldata data,
    uint256 totalReplicationFee,
    uint256 replicationLzTokenAmount
  ) internal {
    if (address(replicator) == address(0)) return;
    if (data.actions.length == 0) return;

    bytes memory payload = abi.encode(data.actions, data.v, data.r, data.s);
    replicator.replicate{ value: totalReplicationFee }(data.actions[0].clientId, payload, replicationLzTokenAmount);
  }

  /**
   * @notice Replicates only successful actions (filtered by bitmap) to archive chains.
   * @dev Used by safeProcessActions. All actions must belong to the same client.
   */
  function replicateFiltered(
    MultiActionData calldata data,
    uint256 successBitmap,
    uint256 successCount,
    uint256 totalReplicationFee,
    uint256 replicationLzTokenAmount
  ) internal {
    if (address(replicator) == address(0)) return;
    if (successCount == 0) return;

    // All actions share the same clientId (enforced by caller's validation loop)
    uint32 clientId = data.actions[0].clientId;

    // Build filtered arrays of only successful actions
    ActionData[] memory filteredActions = new ActionData[](successCount);
    uint8[] memory filteredV = new uint8[](successCount);
    bytes32[] memory filteredR = new bytes32[](successCount);
    bytes32[] memory filteredS = new bytes32[](successCount);

    uint256 idx = 0;
    for (uint256 i = 0; i < data.actions.length; i++) {
      if ((successBitmap & (1 << i)) != 0) {
        filteredActions[idx] = data.actions[i];
        filteredV[idx] = data.v[i];
        filteredR[idx] = data.r[i];
        filteredS[idx] = data.s[i];
        idx++;
      }
    }

    bytes memory payload = abi.encode(filteredActions, filteredV, filteredR, filteredS);
    replicator.replicate{ value: totalReplicationFee }(clientId, payload, replicationLzTokenAmount);
  }

  function setWithdrawable(uint256 withdrawBitmap, uint256 withdrawCount, ActionData[] memory actions, uint256 lzTokenAmountForWithdraws, uint256 withdrawFee) internal {
    if (withdrawCount > 0) {
      uint32[] memory withdrawIds = new uint32[](withdrawCount);
      uint256[] memory withdrawAmounts = new uint256[](withdrawCount);
      uint16 index = 0;
      for (uint16 i = 0; i < actions.length; ) {
        if ((withdrawBitmap & (1 << i)) != 0) {
          withdrawIds[index] = actions[i].senderId;
          // Convert from whole CAW tokens to wei (multiply by 10^18)
          withdrawAmounts[index] = uint256(actions[i].amounts[0]) * 10**18;
          unchecked { ++index; }
        }
        unchecked { ++i; }
      }
      cawName.setWithdrawable{ value: withdrawFee }(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
    }
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken)
  external view returns (MessagingFee memory quote) {
    return cawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }

  function replicationQuote(uint32 clientId, MultiActionData calldata data, bool payInLzToken)
  external view returns (MessagingFee memory quote, uint256 chainCount) {
    // Return zero fees if no replicator is configured
    if (address(replicator) == address(0)) {
      return (MessagingFee(0, 0), 0);
    }
    bytes memory payload = abi.encode(data.actions, data.v, data.r, data.s);
    return replicator.quoteReplication(clientId, payload, payInLzToken);
  }

  function getReplicationDestinations(uint32 clientId) external view returns (ReplicationDestination[] memory) {
    require(address(replicator) != address(0), "Replicator not set");
    return replicator.getReplicationDestinations(clientId);
  }

  function getReplicationCount(uint32 clientId) external view returns (uint256) {
    require(address(replicator) != address(0), "Replicator not set");
    return replicator.getReplicationCount(clientId);
  }
}

