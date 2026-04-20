// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./CawProfileL2.sol";
import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Ownable {
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
    bytes text;        // smltxt-compressed UTF-8 (decompressed by frontends/indexers)
  }

  bytes32 public immutable eip712DomainHash;

  // Checkpointing for verifiable migration to other chains (per-client)
  mapping(uint32 => uint256) public clientActionCount;
  mapping(uint32 => bytes32) public clientCurrentHash;
  mapping(uint32 => mapping(uint256 => bytes32)) public clientHashAtCheckpoint;

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  /// @notice Tracks cumulative spending (whole CAW tokens) per session key (by owner address)
  mapping(address => mapping(address => uint256)) public sessionSpent;

  /// @notice Emitted with the raw packed action bytes so indexers can decode.
  event ActionsProcessed(bytes packedActions);
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

  CawProfileL2 public immutable cawProfile;
  CawActions public immutable externalSelf;

  // Precomputed type hashes for EIP712
  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
    "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
  );

  /// @dev Checkpoint interval — a checkpoint is stored every N actions per client.
  uint256 private constant CHECKPOINT_INTERVAL = 128;

  constructor(address _cawProfiles) {
    eip712DomainHash = generateDomainHash();
    externalSelf = CawActions(this);
    cawProfile = CawProfileL2(_cawProfiles);
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
  //       [4]   uint32  clientId
  //       [4]   uint32  cawonce
  //       [1]   uint8   recipientCount (N)
  //       [1]   uint8   amountCount (M) — as signed (0, N, or N+1)
  //       [4*N] uint32  recipients
  //       [8*M] uint64  amounts
  //       [2]   uint16  textLength (T)
  //       [T]   bytes   text
  //
  //   sigs: concatenated per-action signatures
  //     Per action: [1] v, [32] r, [32] s = 65 bytes each

  /// @notice Process a batch of actions from packed calldata. ~50% less gas than
  ///         the ABI-encoded version because calldata is ~60% smaller.
  function processActions(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable {
    uint256 actionCount = _readU16(packedActions, 0);
    require(actionCount > 0, "No actions");
    require(sigs.length == actionCount * 65, "Sigs length mismatch");

    uint32 firstClientId;
    uint16 withdrawCount;
    uint256 withdrawBitmap;
    uint256 pos = 2; // skip actionCount header

    for (uint256 i = 0; i < actionCount; ) {
      uint256 actionStart = pos;

      // Unpack one action from packed bytes
      (ActionData memory action, uint256 nextPos) = _unpackAction(packedActions, pos);
      pos = nextPos;

      // Enforce single-client constraint
      if (i == 0) {
        firstClientId = action.clientId;
      } else {
        require(action.clientId == firstClientId, "All actions must belong to the same client");
      }

      // Read signature
      (uint8 v, bytes32 r, bytes32 s) = _readSig(sigs, i);

      // Process the action (all validation, token transfers, etc.)
      _processActionPacked(validatorId, action, v, r, s, packedActions[actionStart:pos]);

      // Track withdrawals
      if (action.actionType == ActionType.WITHDRAW) {
        withdrawBitmap |= (1 << i);
        unchecked { ++withdrawCount; }
      }

      unchecked { ++i; }
    }

    emit ActionsProcessed(packedActions);

    // Handle withdrawals
    if (withdrawCount > 0) {
      _handleWithdrawals(withdrawBitmap, withdrawCount, actionCount, packedActions);
    }

    // Forward ETH for LZ withdraw fees if needed
    if (withdrawCount > 0 && withdrawFee > 0) {
      _executeWithdrawals(withdrawFee, withdrawLzTokenAmount);
    }
  }

  /// @notice Safe version — tries each action individually, collects rejections.
  ///         Intended for eth_call simulation before submitting via processActions.
  function safeProcessActions(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes calldata sigs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable returns (uint256 successCount, string[] memory rejections) {
    uint256 actionCount = _readU16(packedActions, 0);
    require(actionCount > 0, "No actions");
    require(sigs.length == actionCount * 65, "Sigs length mismatch");

    rejections = new string[](actionCount);
    uint16 withdrawCount;
    uint256 withdrawBitmap;
    uint256 pos = 2;

    for (uint256 i = 0; i < actionCount; ) {
      uint256 actionStart = pos;
      (ActionData memory action, uint256 nextPos) = _unpackAction(packedActions, pos);
      pos = nextPos;
      (uint8 v, bytes32 r, bytes32 s) = _readSig(sigs, i);

      try CawActions(this).processActionSingle(validatorId, action, v, r, s, packedActions[actionStart:nextPos]) {
        unchecked { ++successCount; }
        if (action.actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);
          unchecked { ++withdrawCount; }
        }
      } catch Error(string memory reason) {
        rejections[i] = reason;
        emit ActionRejected(action.senderId, action.cawonce, reason);
      } catch (bytes memory) {
        rejections[i] = "Low-level exception";
        emit ActionRejected(action.senderId, action.cawonce, "Low-level exception");
      }

      unchecked { ++i; }
    }

    if (successCount > 0) {
      emit ActionsProcessed(packedActions);
    }

    if (withdrawCount > 0 && withdrawFee > 0) {
      _handleWithdrawals(withdrawBitmap, withdrawCount, actionCount, packedActions);
      _executeWithdrawals(withdrawFee, withdrawLzTokenAmount);
    }
  }

  /// @notice External entry for safeProcessActions try/catch. Only callable by self.
  function processActionSingle(
    uint32 validatorId,
    ActionData calldata action,
    uint8 v, bytes32 r, bytes32 s,
    bytes calldata packedSlice
  ) external {
    require(msg.sender == address(this), "Only self");
    _processActionPacked(validatorId, action, v, r, s, packedSlice);
  }

  // ============================================
  // CORE ACTION PROCESSING
  // ============================================

  function _processActionPacked(
    uint32 validatorId,
    ActionData memory action,
    uint8 v, bytes32 r, bytes32 s,
    bytes calldata packedSlice
  ) internal {
    require(!isCawonceUsed(action.senderId, action.cawonce), "Cawonce already used");
    require(cawProfile.authenticated(action.clientId, action.senderId), "User has not authenticated with this client");

    (address signer, bool isSessionKey) = _verifySignatureMem(v, r, s, action);

    require(action.text.length <= 420, "Text exceeds 420 bytes");

    // Fixed protocol costs per action type (in whole CAW tokens)
    uint256 actionCost;
    if (action.actionType == ActionType.CAW) {
      cawProfile.spendAndDistributeTokens(action.senderId, 5000, 5000);
      actionCost = 5000;
    } else if (action.actionType == ActionType.LIKE) {
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, 2000, 400, action.receiverId, 1600);
      actionCost = 2000;
    } else if (action.actionType == ActionType.RECAW) {
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, 4000, 2000, action.receiverId, 2000);
      actionCost = 4000;
    } else if (action.actionType == ActionType.FOLLOW) {
      require(action.senderId != action.receiverId, "Cannot follow yourself");
      cawProfile.spendDistributeAndAddTokensToBalance(action.senderId, 30000, 6000, action.receiverId, 24000);
      actionCost = 30000;
    } else if (action.actionType == ActionType.WITHDRAW) {
      cawProfile.withdraw(action.senderId, uint256(action.amounts[0]) * 10**18);
    } else if (action.actionType != ActionType.UNLIKE &&
               action.actionType != ActionType.UNFOLLOW &&
               action.actionType != ActionType.OTHER) {
      revert("Invalid action type");
    }

    // Distribute amounts (tips, validator fees)
    actionCost += _distributeAmountsMem(validatorId, action);

    // Session spend limit
    if (isSessionKey && actionCost > 0) {
      address owner = cawProfile.ownerOf(action.senderId);
      (,, uint256 spendLimit) = cawProfile.sessions(owner, signer);
      if (spendLimit > 0) {
        sessionSpent[owner][signer] += actionCost;
        require(sessionSpent[owner][signer] <= spendLimit, "Session spend limit exceeded");
      }
    }

    useCawonce(action.senderId, action.cawonce);

    // Checkpoint hash — hash the PACKED slice directly (no abi.encode overhead).
    // This is cryptographically equivalent: the packed bytes uniquely represent
    // the action struct, so keccak256(packedSlice) is collision-resistant.
    uint32 clientId = action.clientId;
    bytes32 actionHash = keccak256(packedSlice);
    clientCurrentHash[clientId] = keccak256(abi.encodePacked(clientCurrentHash[clientId], r, actionHash));
    clientActionCount[clientId]++;

    if (clientActionCount[clientId] % CHECKPOINT_INTERVAL == 0)
      clientHashAtCheckpoint[clientId][clientActionCount[clientId] / CHECKPOINT_INTERVAL] = clientCurrentHash[clientId];
  }

  // ============================================
  // SIGNATURE VERIFICATION
  // ============================================

  /// @dev Compute struct hash from memory struct (used by packed calldata path)
  function _computeStructHash(ActionData memory data) internal pure returns (bytes32) {
    return keccak256(
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
        keccak256(data.text)
      )
    );
  }

  function _verifySignatureMem(
    uint8 v, bytes32 r, bytes32 s,
    ActionData memory data
  ) internal view returns (address signer, bool isSessionKey) {
    bytes32 structHash = _computeStructHash(data);

    signer = getSigner(structHash, v, r, s);
    require(signer != address(0), "Invalid signature");

    address owner = cawProfile.ownerOf(data.senderId);
    if (signer == owner) return (signer, false);

    (uint64 expiry, uint8 scopeBitmap,) = cawProfile.sessions(owner, signer);
    require(expiry > block.timestamp, "Session expired or not found");
    require((scopeBitmap & (1 << uint8(data.actionType))) != 0, "Action not in session scope");
    return (signer, true);
  }

  // ============================================
  // AMOUNT DISTRIBUTION (memory struct version)
  // ============================================

  function _distributeAmountsMem(uint32 validatorId, ActionData memory action) internal returns (uint256 totalWholeTokens) {
    uint256 numRecipients = action.recipients.length;
    uint256 numAmounts = action.amounts.length;

    require(numRecipients <= 10, "Too many recipients");

    if (numAmounts != numRecipients)
      require(numAmounts == numRecipients + 1, "Amounts and recipients mismatch");

    if (numRecipients == 0 && numAmounts == 0) return 0;

    require(cawProfile.ownerOf(validatorId) != address(0), "Invalid validatorId");

    bool isWithdrawal = action.actionType == ActionType.WITHDRAW;
    uint256 startIndex = isWithdrawal ? 1 : 0;

    uint256 amountTotal = uint256(action.amounts[numAmounts - 1]) * 10**18;
    totalWholeTokens = uint256(action.amounts[numAmounts - 1]);

    for (uint256 i = startIndex; i < numRecipients; ) {
      uint256 amountWei = uint256(action.amounts[i]) * 10**18;
      cawProfile.addToBalance(action.recipients[i], amountWei);
      amountTotal += amountWei;
      totalWholeTokens += uint256(action.amounts[i]);
      unchecked { ++i; }
    }

    cawProfile.spendAndDistribute(action.senderId, amountTotal, 0);
    cawProfile.addToBalance(validatorId, uint256(action.amounts[numAmounts - 1]) * 10**18);
  }

  // ============================================
  // PACKED DATA READERS
  // ============================================

  /// @dev Unpack one action from packed calldata at the given byte offset.
  function _unpackAction(bytes calldata packed, uint256 pos)
    internal pure returns (ActionData memory action, uint256 nextPos)
  {
    action.actionType = ActionType(_readU8(packed, pos)); pos += 1;
    action.senderId = _readU32(packed, pos);              pos += 4;
    action.receiverId = _readU32(packed, pos);             pos += 4;
    action.receiverCawonce = _readU32(packed, pos);        pos += 4;
    action.clientId = _readU32(packed, pos);               pos += 4;
    action.cawonce = _readU32(packed, pos);                pos += 4;

    // Recipients
    uint256 rc = _readU8(packed, pos); pos += 1;
    // Amount count (as signed: 0, rc, or rc+1)
    uint256 ac = _readU8(packed, pos); pos += 1;

    action.recipients = new uint32[](rc);
    for (uint256 j = 0; j < rc; ) {
      action.recipients[j] = _readU32(packed, pos); pos += 4;
      unchecked { ++j; }
    }

    // Amounts
    action.amounts = new uint64[](ac);
    for (uint256 j = 0; j < ac; ) {
      action.amounts[j] = _readU64(packed, pos); pos += 8;
      unchecked { ++j; }
    }

    // Text
    uint256 tl = _readU16(packed, pos); pos += 2;
    action.text = packed[pos : pos + tl]; pos += tl;

    nextPos = pos;
  }

  /// @dev Read a signature (v, r, s) from concatenated sigs at action index i.
  function _readSig(bytes calldata sigs, uint256 i)
    internal pure returns (uint8 v, bytes32 r, bytes32 s)
  {
    uint256 off = i * 65;
    v = uint8(sigs[off]);
    r = bytes32(sigs[off + 1 : off + 33]);
    s = bytes32(sigs[off + 33 : off + 65]);
  }

  function _readU8(bytes calldata d, uint256 pos) internal pure returns (uint8) {
    return uint8(d[pos]);
  }
  function _readU16(bytes calldata d, uint256 pos) internal pure returns (uint16) {
    return (uint16(uint8(d[pos])) << 8) | uint16(uint8(d[pos + 1]));
  }
  function _readU32(bytes calldata d, uint256 pos) internal pure returns (uint32) {
    return (uint32(uint8(d[pos])) << 24) | (uint32(uint8(d[pos+1])) << 16) |
           (uint32(uint8(d[pos+2])) << 8) | uint32(uint8(d[pos+3]));
  }
  function _readU64(bytes calldata d, uint256 pos) internal pure returns (uint64) {
    return (uint64(uint8(d[pos])) << 56) | (uint64(uint8(d[pos+1])) << 48) |
           (uint64(uint8(d[pos+2])) << 40) | (uint64(uint8(d[pos+3])) << 32) |
           (uint64(uint8(d[pos+4])) << 24) | (uint64(uint8(d[pos+5])) << 16) |
           (uint64(uint8(d[pos+6])) << 8)  | uint64(uint8(d[pos+7]));
  }

  // ============================================
  // WITHDRAWAL HELPERS
  // ============================================

  /// @dev Scan packed actions to collect withdrawal IDs and amounts.
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
      // Read senderId (offset 1 from action start) and skip to amounts
      uint32 senderId = _readU32(packedActions, pos + 1);
      // Skip fixed fields: 1 + 4*5 = 21
      uint256 aPos = pos + 21;
      uint256 rc = _readU8(packedActions, aPos); aPos += 1;
      uint256 ac = _readU8(packedActions, aPos); aPos += 1;
      aPos += rc * 4; // skip recipients
      // First amount (withdrawal amount for WITHDRAW actions)
      uint64 firstAmount = _readU64(packedActions, aPos);
      aPos += ac * 8; // skip all amounts
      uint256 tl = _readU16(packedActions, aPos); aPos += 2;
      aPos += tl; // skip text

      if ((withdrawBitmap & (1 << i)) != 0) {
        withdrawIds[wIdx] = senderId;
        withdrawAmounts[wIdx] = uint256(firstAmount) * 10**18;
        unchecked { ++wIdx; }
      }

      pos = aPos;
      unchecked { ++i; }
    }

    // Store for _executeWithdrawals
    _pendingWithdrawIds = withdrawIds;
    _pendingWithdrawAmounts = withdrawAmounts;
  }

  uint32[] private _pendingWithdrawIds;
  uint256[] private _pendingWithdrawAmounts;

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

  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce >> 8;
    uint256 bit = cawonce & 0xff;
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
