// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "./CawNameL2.sol";

import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Context {
  enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, NOOP }

  struct ActionData {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 receiverCawonce;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint128[] amounts;
    string text;
  }

  struct MultiActionData {
    ActionData[] actions;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
  }

  bytes32 internal immutable eip712DomainHash;
  bytes32 internal currentHash = bytes32("genesis");

  mapping(uint32 => mapping(uint256 => uint256)) internal usedCawonce;
  mapping(uint32 => uint256) internal currentCawonceMap;

  event ActionsProcessed(ActionData[] actions);
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

  CawNameL2 internal immutable CawName;
  CawActions internal immutable externalSelf;

  // Precomputed type hashes for EIP712
  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
    "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts,string text)"
  );

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    externalSelf = CawActions(this);
    CawName = CawNameL2(_cawNames);
  }

  function processAction(uint32 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    _processAction(validatorId, action, v, r, s);
  }

  function _processAction(uint32 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) internal {
    require(!isCawonceUsed(action.senderId, action.cawonce), "Cawonce already used");
    require(CawName.authenticated(action.clientId, action.senderId), "User has not authenticated with this client");

    verifySignature(v, r, s, action);

    if (action.actionType == ActionType.CAW) {
      require(bytes(action.text).length <= 420, "Text exceeds 420 characters");
      CawName.spendAndDistributeTokens(action.senderId, 5000, 5000);
    } else if (action.actionType == ActionType.LIKE)
      CawName.spendDistributeAndAddTokensToBalance(action.senderId, 2000, 400, action.receiverId, 1600);
    else if (action.actionType == ActionType.RECAW) {
      CawName.spendDistributeAndAddTokensToBalance(action.senderId, 4000, 2000, action.receiverId, 2000);
    } else if (action.actionType == ActionType.FOLLOW) {
      require(action.senderId != action.receiverId, "Cannot follow yourself");
      CawName.spendDistributeAndAddTokensToBalance(action.senderId, 30000, 6000, action.receiverId, 24000);
    } else if (action.actionType == ActionType.WITHDRAW)
      CawName.withdraw(action.senderId, action.amounts[0]);
    else if ( action.actionType != ActionType.UNLIKE &&
        action.actionType != ActionType.UNFOLLOW &&
        action.actionType != ActionType.NOOP)
      revert("Invalid action type");

    distributeAmounts(validatorId, action);
    useCawonce(action.senderId, action.cawonce);

    currentHash = keccak256(abi.encodePacked(currentHash, r));
  }

  function getCurrentHash() public view returns (bytes32) {
    return currentHash;
  }

  function getCawNameAddress() public view returns (address) {
    return address(CawName);
  }

  function distributeAmounts(uint32 validatorId, ActionData calldata action) internal {
    uint256 numRecipients = action.recipients.length;
    uint256 numAmounts = action.amounts.length;

    if (numAmounts != numRecipients)
      require(numAmounts == numRecipients + 1, "Amounts and recipients mismatch");

    if (numRecipients == 0 && numAmounts == 0) return;

    bool isWithdrawal = action.actionType == ActionType.WITHDRAW;
    uint256 startIndex = isWithdrawal ? 1 : 0;

    uint256 amountTotal = action.amounts[numAmounts - 1];

    for (uint256 i = startIndex; i < numRecipients; ) {
      CawName.addToBalance(action.recipients[i], action.amounts[i]);
      amountTotal += action.amounts[i];
      unchecked { ++i; }
    }

    CawName.spendAndDistribute(action.senderId, amountTotal, 0);
    CawName.addToBalance(validatorId, action.amounts[numAmounts - 1]);
  }

  function verifySignature(
    uint8 v,
    bytes32 r,
    bytes32 s,
    ActionData calldata data
  ) internal view {
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

    address signer = getSigner(structHash, v, r, s);
    require(signer == CawName.ownerOf(data.senderId), "Invalid signer");
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
        keccak256(bytes("CawNet")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
    )
    );
  }

  // This function can be used to process actions, but by design it
  // will consume more gas. This funciton will not short circuit
  // and fail if an action is rejected. The actual intention of
  // this function is intended to be used with eth_call,
  // which does not execute or change state on the block
  // chain. The returned actions from this using eth_call
  // will have been fully verified and should be able to
  // be processed successfully via processActions.
  function safeProcessActions(uint32 validatorId, MultiActionData calldata data, uint256 lzTokenAmountForWithdraws) external payable returns (ActionData[] memory){
    uint256 actionsLength = data.actions.length;
    require(actionsLength <= 256, "Cannot process more than 256 actions");

    uint16 successCount;
    uint16 withdrawCount;
    uint256 successBitmap = 0;
    uint256 withdrawBitmap = 0;

    for (uint16 i = 0; i < actionsLength; ) {
      try CawActions(this).processAction(validatorId, data.actions[i], data.v[i], data.r[i], data.s[i]) {
        successBitmap |= (1 << i);
        if (data.actions[i].actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);
          unchecked { ++withdrawCount; }
        }
        unchecked { ++successCount; }
      } catch Error(string memory reason) {
        emit ActionRejected(data.actions[i].senderId, data.actions[i].cawonce, reason);
      } catch (bytes memory) {
        emit ActionRejected(data.actions[i].senderId, data.actions[i].cawonce, "Low-level exception");
      }
      unchecked { ++i; }
    }

    ActionData[] memory successfulActions = new ActionData[](successCount);
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

    setWithdrawable(withdrawBitmap, withdrawCount, data.actions, lzTokenAmountForWithdraws);
    return successfulActions;
  }

  function processActions(uint32 validatorId, MultiActionData calldata data, uint256 lzTokenAmountForWithdraws) external payable {
    uint256 actionsLength = data.actions.length;
    require(actionsLength <= 256, "Cannot process more than 256 actions");

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

    setWithdrawable(withdrawBitmap, withdrawCount, data.actions, lzTokenAmountForWithdraws);
  }


  function setWithdrawable(uint256 withdrawBitmap, uint256 withdrawCount, ActionData[] memory actions, uint256 lzTokenAmountForWithdraws) internal {
    if (withdrawCount > 0) {
      uint32[] memory withdrawIds = new uint32[](withdrawCount);
      uint256[] memory withdrawAmounts = new uint256[](withdrawCount);
      uint16 index = 0;
      for (uint16 i = 0; i < actions.length; ) {
        if ((withdrawBitmap & (1 << i)) != 0) {
          withdrawIds[index] = actions[i].senderId;
          withdrawAmounts[index] = actions[i].amounts[0];
          unchecked { ++index; }
        }
        unchecked { ++i; }
      }
      CawName.setWithdrawable{ value: msg.value }(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
    }
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken)
  external view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }
}

