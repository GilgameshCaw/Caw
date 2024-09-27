// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "./CawNameL2.sol";

import { MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawActions is Context {

  enum ActionType{ CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW  }

  struct ActionData {
    ActionType actionType;
    uint64 senderId;
    uint64 receiverId;
    uint64[] recipients;
    uint64 timestamp;
    address sender;
    uint256[] amounts;
    uint64 clientId;
    bytes32 cawId;
    uint64 cawonce;
    string text;
  }

  struct MultiActionData {
    ActionData[] actions;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
  }

  bytes32 public eip712DomainHash;

  bytes32 public currentHash = bytes32("genesis");

  mapping(uint64 => uint64) public processedActions;
  mapping(uint64 => uint64) public cawonce;

  event ActionsProcessed(uint64 validatorId, MultiActionData actions);
  event ActionRejected(uint64 validatorId, bytes32 actionId, string reason);

  CawNameL2 CawName;

  constructor(address _cawNames)
  {
    eip712DomainHash = generateDomainHash();
    CawName = CawNameL2(_cawNames);
  }

  function processAction(uint64 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "caller is not the CawActions contract");

    verifySignature(v, r, s, action);

    if (action.actionType == ActionType.CAW)
      caw(action);
    else if (action.actionType == ActionType.LIKE)
      likeCaw(action);
    else if (action.actionType == ActionType.UNLIKE)
      unlikeCaw(action);
    else if (action.actionType == ActionType.RECAW)
      reCaw(action);
    else if (action.actionType == ActionType.FOLLOW)
      followUser(action);
    else if (action.actionType == ActionType.UNFOLLOW)
      unfollowUser(action);
    else if (action.actionType == ActionType.WITHDRAW)
      withdraw(action);
    else revert("Invalid action type");

    distributeAmounts(validatorId, action);
    cawonce[action.senderId] += 1;

    currentHash = keccak256(abi.encodePacked(currentHash, r));
  }

  function distributeAmounts(uint64 validatorId, ActionData calldata action) internal {
    if (action.amounts.length + action.recipients.length == 0) return; // no amounts
    bool isWithdrawl = action.actionType == ActionType.WITHDRAW;

    // If the user is trigging a withdraw, the first element should be skipped,
    // because it will be the amount intending to be withdrawn
    if (isWithdrawl && action.amounts.length == 1 && action.recipients.length == 1) return;
    uint256 startIndex = isWithdrawl ? 1 : 0;

    require(
      action.recipients.length == action.amounts.length - 1,
      'The amounts list must have exactly one more value than the recipients list'
    ); // the last value in the amounts array is given to the validator

    uint256 amountTotal = action.amounts[action.amounts.length-1];

    for (uint256 i = startIndex; i < action.recipients.length; i++) {
      CawName.addToBalance(action.recipients[i], action.amounts[i]);
      amountTotal += action.amounts[i];
    }

    CawName.addToBalance(validatorId, action.amounts[action.amounts.length-1]);
    CawName.spendAndDistribute(action.senderId, amountTotal, 0);
  }

  function caw(
    ActionData calldata data
  ) internal {
    require(bytes(data.text).length <= 420, 'text must be less than 420 characters');
    CawName.spendAndDistributeTokens(data.senderId, 5000, 5000);
  }

  function withdraw(
    ActionData calldata data
  ) internal {
    CawName.withdraw(data.senderId, data.amounts[0]);
  }

  function likeCaw(
    ActionData calldata data
  ) internal {
    // This function can be called more than once from the same user to the same CAW.
    // front ends should manage any duplicate likes as a no-op. Validators and front-ends
    // should prevent users from calling this more than once, because nothing will happen
    // except the actor will spend more CAW.
    // 
    // If a user likes their own caw, 400 caw will still be distributed among all stakers.
    CawName.spendAndDistributeTokens(data.senderId, 2000, 400);
    CawName.addTokensToBalance(data.receiverId, 1600);
  }

  function unlikeCaw(
    ActionData calldata data
  ) internal {
    // This is a no-op, but it should get processed nonetheless,
    // so front-end clients can see that it was successful
  }

  function reCaw(
    ActionData calldata data
  ) internal {
    CawName.spendAndDistributeTokens(data.senderId, 4000, 2000);
    CawName.addTokensToBalance(data.receiverId, 2000);
  }

  function unfollowUser(
    ActionData calldata data
  ) internal {
    // This is a no-op, but it should get processed nonetheless,
    // so front-end clients can see that it was successful
  }

  function followUser(
    ActionData calldata data
  ) internal {
    require(data.senderId != data.receiverId, 'cannot follow yourself');
    CawName.spendAndDistributeTokens(data.senderId, 30000, 6000);
    CawName.addTokensToBalance(data.receiverId, 24000);
  }

  function verifySignature(
    uint8 v, bytes32 r, bytes32 s,
    ActionData calldata data
  ) internal view {
    require(cawonce[data.senderId] == data.cawonce, 'incorrect cawonce');
    bytes memory hash = abi.encode(
      keccak256("ActionData(uint8 actionType,uint64 senderId,uint64 receiverId,uint64[] recipients,uint64 timestamp,uint256[] amounts,address sender,bytes32 cawId,string text)"),
      data.actionType, data.senderId, data.receiverId,
      keccak256(abi.encodePacked(data.recipients)), data.timestamp, 
      keccak256(abi.encodePacked(data.amounts)),  data.sender, data.cawId,
      keccak256(bytes(data.text))
    );

    address signer = getSigner(hash, v, r, s);
    require(signer == CawName.ownerOf(data.senderId), "signer is not owner of this CawName");
    if (!CawName.authenticated(data.clientId, data.senderId))
      revert("User has not authenticated with this client");
  }

  function getSigner(
    bytes memory hashedObject,
    uint8 v, bytes32 r, bytes32 s
  ) public view returns (address) {
    uint256 chainId;
    assembly {
      chainId := chainid()
    }

    bytes32 hash = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, keccak256(hashedObject)));
    return ecrecover(hash, v,r,s);
  }

  function generateDomainHash() internal view returns (bytes32) {
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

  function processActions(uint64 validatorId, MultiActionData calldata data, uint256 lzTokenAmountForWithdraws) external payable {
    uint8[] calldata v = data.v;
    bytes32[] calldata r = data.r;
    bytes32[] calldata s = data.s;

    uint16 successCount;
    uint16 withdrawCount;

    // Bitmaps to track success and withdraw actions
    uint256 successBitmap = 0;
    uint256 withdrawBitmap = 0;

    // First pass: Process actions and set success/withdraw bits
    for (uint16 i = 0; i < data.actions.length; i++) {
      try CawActions(this).processAction(validatorId, data.actions[i], v[i], r[i], s[i]) {
        // Mark this action as successful in the bitmap
        successBitmap |= (1 << i);  // Set the ith bit to 1

        // Check if the action is a withdraw
        if (data.actions[i].actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);  // Set the ith bit to 1
          withdrawCount++;
        }

        successCount += 1;
      } catch Error(string memory reason) {
        emit ActionRejected(validatorId, data.r[i], reason);
      }
    }

    // Only allocate arrays after counting successful actions
    MultiActionData memory successfulActions;
    if (successCount > 0) {
      successfulActions.v = new uint8[](successCount);
      successfulActions.r = new bytes32[](successCount);
      successfulActions.s = new bytes32[](successCount);
      successfulActions.actions = new ActionData[](successCount);
    }

    uint64[] memory withdrawIds;
    uint256[] memory withdrawAmounts;
    if (withdrawCount > 0) {
      withdrawIds = new uint64[](withdrawCount);
      withdrawAmounts = new uint256[](withdrawCount);
    }

    // Second pass: Populate arrays based on bitmaps
    uint16 successIndex = 0;
    uint16 withdrawIndex = 0;

    for (uint16 i = 0; i < data.actions.length; i++) {
      if ((successBitmap & (1 << i)) != 0) {
        // This action was successful, so add it to the successfulActions array
        successfulActions.v[successIndex] = data.v[i];
        successfulActions.r[successIndex] = data.r[i];
        successfulActions.s[successIndex] = data.s[i];
        successfulActions.actions[successIndex] = data.actions[i];
        successIndex++;
      }

      if ((withdrawBitmap & (1 << i)) != 0) {
        // This action was a successful withdraw, so add it to the withdrawIds and withdrawAmounts arrays
        withdrawIds[withdrawIndex] = data.actions[i].senderId;
        withdrawAmounts[withdrawIndex] = data.actions[i].amounts[0];
        withdrawIndex++;
      }
    }

    // Emit the successful actions event if any were processed
    if (successCount > 0) emit ActionsProcessed(validatorId, successfulActions);

    // Call setWithdrawable with the withdraw tokens and amounts
    if (withdrawCount > 0) CawName.setWithdrawable{value: msg.value}(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
  }

  function withdrawQuote(uint64[] memory tokenIds, uint256[] memory amounts, bool payInLzToken) public view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }


}

