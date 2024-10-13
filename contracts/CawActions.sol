// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./CawNameL2.sol";

import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Context {

  enum ActionType{ CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, NOOP  }

  struct ActionData {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 clientId;
    uint32 cawonce;
    uint32 receiverCawonce;
    uint32 transferRecipient;
    uint128 amountToTransfer; // Only included if transferRecipient != 0
    uint64 validatorTipAmount;
    string text;
  }

  struct MultiActionData {
    bytes[] actions;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
  }

  bytes32 public eip712DomainHash;

  bytes32 public currentHash = bytes32("genesis");

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  event ActionsProcessed(bytes actions);
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

  CawNameL2 public CawName;

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    CawName = CawNameL2(_cawNames);
  }

  function processAction(
    uint32 validatorId,
    ActionType actionType,
    uint32 senderId,
    uint32 cawonce,
    uint32 clientId,
    bytes calldata actionData,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external {
    require(address(this) == _msgSender(), "Caller is not the CawActions contract");
    require(!isCawonceUsed(senderId, cawonce), "cawonce already used");
    require(CawName.authenticated(clientId, senderId), "User has not authenticated with this client");

    // Verify signature
    verifySignature(actionData, v, r, s, senderId);


    if (actionType == ActionType.CAW) {
      uint16 textLength = readTextLength(actionData);
      caw(senderId, textLength);
    } else if (actionType == ActionType.LIKE) {
      uint32 receiverId = readReceiverId(actionData);
      likeCaw(senderId, receiverId);
    } else if (actionType == ActionType.UNLIKE) {
      unlikeCaw();
    } else if (actionType == ActionType.UNFOLLOW) {
      unfollowUser();
    } else if (actionType == ActionType.RECAW) {
      uint32 receiverId = readReceiverId(actionData);
      reCaw(senderId, receiverId);
    } else if (actionType == ActionType.FOLLOW) {
      uint32 receiverId = readReceiverId(actionData);
      followUser(senderId, receiverId);
    } else if (actionType == ActionType.WITHDRAW) {
      uint128 amountToTransfer = readAmountToTransfer(actionData);
      withdraw(senderId, amountToTransfer);
    } else if (actionType != ActionType.NOOP) {
      revert("Invalid action type");
    }

    distributeAmounts(validatorId, senderId, actionData);
    useCawonce(senderId, cawonce);

    currentHash = keccak256(abi.encodePacked(currentHash, r));
  }

  function distributeAmounts(uint32 validatorId, uint32 senderId, bytes calldata actionData) internal {
    uint64 validatorTipAmount = readValidatorTipAmount(actionData);
    uint32 transferRecipient = readTransferRecipient(actionData);

    uint256 amountTotal = uint256(validatorTipAmount);

    if (validatorTipAmount > 0) {
      CawName.addToBalance(validatorId, validatorTipAmount);
    }

    if (transferRecipient != 0) {
      uint128 amountToTransfer = readAmountToTransfer(actionData);
      amountTotal += uint256(amountToTransfer);
      CawName.addToBalance(transferRecipient, amountToTransfer);
    }

    if (amountTotal > 0) {
      CawName.spendAndDistribute(senderId, amountTotal, 0);
    }
  }

  function caw(uint32 senderId, uint16 textLength) internal {
    require(textLength <= 420, "Text must be less than 420 characters");
    CawName.spendAndDistributeTokens(senderId, 5000, 5000);
  }

  function withdraw(uint32 senderId, uint128 amountToTransfer) internal {
    CawName.withdraw(senderId, amountToTransfer);
  }

  function likeCaw(uint32 senderId, uint32 receiverId) internal {
    CawName.spendAndDistributeTokens(senderId, 2000, 400);
    CawName.addTokensToBalance(receiverId, 1600);
  }

  function unlikeCaw() internal {
    // No-op
  }

  function reCaw(uint32 senderId, uint32 receiverId) internal {
    CawName.spendAndDistributeTokens(senderId, 4000, 2000);
    CawName.addTokensToBalance(receiverId, 2000);
  }

  function unfollowUser() internal {
    // No-op
  }

  function followUser(uint32 senderId, uint32 receiverId) internal {
    require(senderId != receiverId, "Cannot follow yourself");
    CawName.spendAndDistributeTokens(senderId, 30000, 6000);
    CawName.addTokensToBalance(receiverId, 24000);
  }

  function verifySignature(
    bytes calldata actionData,
    uint8 v,
    bytes32 r,
    bytes32 s,
    uint32 senderId
  ) public view {
    bytes32 typeHash = keccak256("ActionData(bytes actionData)");
    bytes32 structHash = keccak256(abi.encode(
      typeHash,
      keccak256(actionData)
    ));
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19\x01",
      eip712DomainHash,
      structHash
    ));
    address signer = ecrecover(digest, v, r, s);

    require(signer == CawName.ownerOf(senderId), "signer is not owner of this CawName");
  }

  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce / 256;
    uint256 bit = cawonce % 256;
    usedCawonce[senderId][word] |= (1 << bit);
    while (usedCawonce[senderId][currentCawonceMap[senderId]] == type(uint256).max)
      currentCawonceMap[senderId] += 1;
  }

  function nextCawonce(uint32 senderId) public view returns (uint256) {
    uint256 currentMap = currentCawonceMap[senderId];
    uint256 word = usedCawonce[senderId][currentMap];
    if (word == 0) return (currentMap * 256);

    uint256 nextSlot;
    for (nextSlot = 1; nextSlot < 256; nextSlot++)
    if (((1 << nextSlot) & word) == 0) break;

    return (currentCawonceMap[senderId] * 256) + nextSlot;
  }

  function isCawonceUsed(uint32 senderId, uint256 cawonce) public view returns (bool) {
    uint256 word = cawonce / 256;
    uint256 bit = cawonce % 256;
    return (usedCawonce[senderId][word] & (1 << bit)) != 0;
  }

  function generateDomainHash() public view returns (bytes32) {
    uint256 chainId;
    assembly {
      chainId := chainid()
    }
    return keccak256(
      abi.encode(
        keccak256(
          "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    ),
    keccak256(bytes("CawNet")),
    keccak256(bytes("1")),
    chainId,
    address(this)
    )
    );
  }

  function processActions(uint32 validatorId, MultiActionData calldata data, uint256 lzTokenAmountForWithdraws) external payable {
    uint8[] calldata v = data.v;
    bytes32[] calldata r = data.r;
    bytes32[] calldata s = data.s;

    require(data.actions.length <= 256, "Can only process 256 actions at once");
    uint16 successCount;
    uint16 withdrawCount;

    uint32[] memory withdrawIds = new uint32[](data.actions.length);
    uint256[] memory withdrawAmounts = new uint256[](data.actions.length);
    bytes memory successfulActions;

    for (uint16 i = 0; i < data.actions.length; i++) {
      bytes calldata actionData = data.actions[i];

      // Extract necessary data once
      ActionType actionType = readActionType(actionData);
      uint32 senderId = readSenderId(actionData);
      uint32 cawonce = readCawonce(actionData);
      uint32 clientId = readClientId(actionData);

      try CawActions(this).processAction(validatorId, actionType, senderId, cawonce, clientId, actionData, v[i], r[i], s[i]) {
        if (actionType == ActionType.WITHDRAW) {
          uint128 amountToTransfer = readAmountToTransfer(actionData);

          withdrawIds[withdrawCount] = senderId;
          withdrawAmounts[withdrawCount] = amountToTransfer;
          withdrawCount += 1;
        }

        successCount += 1;
        successfulActions = abi.encodePacked(successfulActions, actionData);
      } catch Error(string memory reason) {
        emit ActionRejected(senderId, cawonce, reason);
      } catch Panic(uint256 errorCode) {
        string memory errorCodeStr = Strings.toString(errorCode);
        emit ActionRejected(senderId, cawonce, string(abi.encodePacked("Panic error code: ", errorCodeStr)));
      } catch (bytes memory /*lowLevelData*/) {
        emit ActionRejected(senderId, cawonce, "Low level exception");
      }
    }

    assembly {
      mstore(withdrawIds, withdrawCount)
      mstore(withdrawAmounts, withdrawCount)
    }

    if (successCount > 0) emit ActionsProcessed(successfulActions);

    if (withdrawCount > 0) CawName.setWithdrawable{value: msg.value}(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken) public view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }

  function packActionData(ActionData memory action) public pure returns (bytes memory) {
    bytes memory data = abi.encodePacked(
      uint8(action.actionType),
      action.senderId,
      action.receiverId,
      action.clientId,
      action.cawonce,
      action.receiverCawonce,
      action.transferRecipient
    );

    if (action.transferRecipient != 0) {
      data = abi.encodePacked(data, action.amountToTransfer);
    }

    data = abi.encodePacked(data, action.validatorTipAmount);

    bytes memory textBytes = bytes(action.text);
    require(textBytes.length <= 65535, "Text too long");
    data = abi.encodePacked(data, uint16(textBytes.length), textBytes);
    return data;
  }

  function unpackActionData(bytes memory data) external pure returns (ActionData memory action) {
    uint256 offset = 0;

    require(data.length >= offset + 29, "Data too short"); // Adjusted minimum length

    action.actionType = ActionType(uint8(data[offset]));
    offset += 1;

    action.senderId = readUint32Mem(data, offset);
    offset += 4;

    action.receiverId = readUint32Mem(data, offset);
    offset += 4;

    action.clientId = readUint32Mem(data, offset);
    offset += 4;

    action.cawonce = readUint32Mem(data, offset);
    offset += 4;

    action.receiverCawonce = readUint32Mem(data, offset);
    offset += 4;

    action.transferRecipient = readUint32Mem(data, offset);
    offset += 4;

    if (action.transferRecipient != 0) {
      require(data.length >= offset + 16, "Data too short for amountToTransfer");
      action.amountToTransfer = readUint128Mem(data, offset);
      offset += 16;
    }

    require(data.length >= offset + 8, "Data too short for validatorTipAmount");
    action.validatorTipAmount = readUint64Mem(data, offset);
    offset += 8;

    require(data.length >= offset + 2, "Data too short for text length");
    uint16 textLength = readUint16Mem(data, offset);
    offset += 2;

    require(data.length >= offset + textLength, "Data too short for text");
    action.text = readStringMem(data, offset, textLength);
  }

  // Helper functions to read uint16, uint32, uint64, uint128, and string from bytes memory data

  function readUint16Mem(bytes memory data, uint256 offset) internal pure returns (uint16 result) {
    require(data.length >= offset + 2, "Out of bounds for uint16");
    result =
      (uint16(uint8(data[offset])) << 8) |
      uint16(uint8(data[offset + 1]));
  }

  function readUint32Mem(bytes memory data, uint256 offset) internal pure returns (uint32 result) {
    require(data.length >= offset + 4, "Out of bounds for uint32");
    result =
      (uint32(uint8(data[offset])) << 24) |
      (uint32(uint8(data[offset + 1])) << 16) |
      (uint32(uint8(data[offset + 2])) << 8) |
      uint32(uint8(data[offset + 3]));
  }

  function readUint64Mem(bytes memory data, uint256 offset) internal pure returns (uint64 result) {
    require(data.length >= offset + 8, "Out of bounds for uint64");
    for (uint256 i = 0; i < 8; i++) {
      result |= uint64(uint8(data[offset + i])) << uint64((7 - i) * 8);
    }
  }

  function readUint128Mem(bytes memory data, uint256 offset) internal pure returns (uint128 result) {
    require(data.length >= offset + 16, "Out of bounds for uint128");
    for (uint256 i = 0; i < 16; i++) {
      result |= uint128(uint8(data[offset + i])) << uint128((15 - i) * 8);
    }
  }

  function readStringMem(bytes memory data, uint256 offset, uint16 textLength) internal pure returns (string memory) {
    require(data.length >= offset + textLength, "Out of bounds for string data");
    bytes memory textBytes = new bytes(textLength);
    for (uint256 i = 0; i < textLength; i++) {
      textBytes[i] = data[offset + i];
    }
    return string(textBytes);
  }

  // Helper functions for reading from calldata

  function readUint16(bytes calldata data, uint256 offset) internal pure returns (uint16 result) {
    require(data.length >= offset + 2, "Out of bounds for uint16");
    result =
      (uint16(uint8(data[offset])) << 8) |
      uint16(uint8(data[offset + 1]));
  }

  function readUint32(bytes calldata data, uint256 offset) internal pure returns (uint32 result) {
    require(data.length >= offset + 4, "Out of bounds for uint32");
    result =
      (uint32(uint8(data[offset])) << 24) |
      (uint32(uint8(data[offset + 1])) << 16) |
      (uint32(uint8(data[offset + 2])) << 8) |
      uint32(uint8(data[offset + 3]));
  }

  function readUint64(bytes calldata data, uint256 offset) internal pure returns (uint64 result) {
    require(data.length >= offset + 8, "Out of bounds for uint64");
    for (uint256 i = 0; i < 8; i++) {
      result |= uint64(uint8(data[offset + i])) << uint64((7 - i) * 8);
    }
  }

  function readUint128(bytes calldata data, uint256 offset) internal pure returns (uint128 result) {
    require(data.length >= offset + 16, "Out of bounds for uint128");
    for (uint256 i = 0; i < 16; i++) {
      result |= uint128(uint8(data[offset + i])) << uint128((15 - i) * 8);
    }
  }

  function readActionType(bytes calldata data) internal pure returns (ActionType) {
    require(data.length >= 1, "Data too short");
    return ActionType(uint8(data[0]));
  }

  function readSenderId(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 1);
  }

  function readReceiverId(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 5);
  }

  function readClientId(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 9);
  }

  function readCawonce(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 13);
  }

  function readReceiverCawonce(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 17);
  }

  function readTransferRecipient(bytes calldata data) internal pure returns (uint32) {
    return readUint32(data, 21);
  }

  function readAmountToTransfer(bytes calldata data) internal pure returns (uint128) {
    uint256 offset = 25; // After transferRecipient
    if (readTransferRecipient(data) != 0) {
      return readUint128(data, offset);
    } else {
      return 0;
    }
  }

  function readValidatorTipAmount(bytes calldata data) internal pure returns (uint64) {
    uint256 offset = 25; // Start after transferRecipient
    if (readTransferRecipient(data) != 0) {
      offset += 16; // Skip amountToTransfer if transferRecipient != 0
    }
    return readUint64(data, offset);
  }

  function readTextLength(bytes calldata data) internal pure returns (uint16) {
    uint256 offset = 25; // Start after transferRecipient
    if (readTransferRecipient(data) != 0) {
      offset += 16; // Skip amountToTransfer
    }
    offset += 8; // Skip validatorTipAmount
    return readUint16(data, offset);
  }

  function readText(bytes calldata data) internal pure returns (string memory) {
    uint16 textLength = readTextLength(data);
    uint256 offset = 25; // Start after transferRecipient
    if (readTransferRecipient(data) != 0) {
      offset += 16; // Skip amountToTransfer
    }
    offset += 8; // Skip validatorTipAmount
    offset += 2; // Skip textLength
    require(data.length >= offset + textLength, "Data too short for text");
    bytes memory textBytes = new bytes(textLength);
    for (uint256 i = 0; i < textLength; i++) {
      textBytes[i] = data[offset + i];
    }
    return string(textBytes);
  }
}

