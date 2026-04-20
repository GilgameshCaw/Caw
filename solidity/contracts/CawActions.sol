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
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
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
    uint256 actionCount;
    assembly { actionCount := shr(240, calldataload(packedActions.offset)) }
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
      mstore(add(buf, 0xA0),   mload(add(data, 0x80)))   // clientId
      mstore(add(buf, 0xC0),   mload(add(data, 0xA0)))   // cawonce
      mstore(add(buf, 0xE0),   recipHash)
      mstore(add(buf, 0x100),  amtHash)
      mstore(add(buf, 0x120),  textHash)
      result := keccak256(buf, 0x140)
    }
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
      // clientId: 4 bytes at bits [151..120]
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

  /// @dev Read a signature (v, r, s) from concatenated sigs using calldataload.
  function _readSig(bytes calldata sigs, uint256 i)
    internal pure returns (uint8 v, bytes32 r, bytes32 s)
  {
    assembly {
      let off := add(sigs.offset, mul(i, 65))
      v := shr(248, calldataload(off))
      r := calldataload(add(off, 1))
      s := calldataload(add(off, 33))
    }
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
      uint32 senderId;
      uint64 firstAmount;
      assembly {
        let cdOff := add(packedActions.offset, pos)
        let w := calldataload(cdOff)
        // senderId at offset 1 (bits 247..216)
        senderId := and(shr(216, w), 0xFFFFFFFF)
        // rc at offset 21 (bits 87..80), ac at offset 22 (bits 79..72)
        let rc := and(shr(80, w), 0xFF)
        let ac := and(shr(72, w), 0xFF)
        // Skip: 23 fixed + rc*4 recipients
        let amtOff := add(add(cdOff, 23), mul(rc, 4))
        // First amount (8 bytes)
        firstAmount := and(shr(192, calldataload(amtOff)), 0xFFFFFFFFFFFFFFFF)
        // Skip: amounts + textLength + text
        amtOff := add(amtOff, mul(ac, 8))
        let tl := shr(240, calldataload(amtOff))
        pos := sub(add(add(amtOff, 2), tl), packedActions.offset)
      }

      if ((withdrawBitmap & (1 << i)) != 0) {
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
