// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";

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

  bytes32 public eip712DomainHash;

  bytes32 public currentHash = bytes32("genesis");

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  event ActionsProcessed(bytes actions);
  event ActionRejected(bytes32 actionId, string reason);

  CawNameL2 CawName;

  constructor(address _cawNames)
  {
    eip712DomainHash = generateDomainHash();
    CawName = CawNameL2(_cawNames);
  }

  function processAction(uint32 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "caller is not the CawActions contract");
    require(!isCawonceUsed(action.senderId, action.cawonce), 'cawonce used already');

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
    else if (action.actionType != ActionType.NOOP)
      revert("Invalid action type");

    distributeAmounts(validatorId, action);
    useCawonce(action.senderId, action.cawonce);

    currentHash = keccak256(abi.encodePacked(currentHash, r));
  }

  function distributeAmounts(uint32 validatorId, ActionData calldata action) internal {
    require(action.amounts.length < 8, 'Can not distribute more than 7 amounts at once');
    if (action.amounts.length + action.recipients.length == 0) return; // no amounts
    bool isWithdrawl = action.actionType == ActionType.WITHDRAW;

    // If the user is triggering a withdraw, the first element should be skipped,
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

  function noop(
    ActionData calldata data
  ) internal { }

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
  ) public view {
    bytes memory hash = abi.encode(
      keccak256("ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts,string text)"),
      data.actionType, data.senderId, data.receiverId, data.clientId, data.cawonce, 
      keccak256(abi.encodePacked(data.recipients)),
      keccak256(abi.encodePacked(data.amounts)),
      keccak256(bytes(data.text))
    );

    address signer = getSigner(hash, v, r, s);
    require(signer == CawName.ownerOf(data.senderId), "signer is not owner of this CawName");
    if (!CawName.authenticated(data.clientId, data.senderId))
      revert("User has not authenticated with this client");
  }

  /**
   * @dev Marks a cawonce as used for a specific senderId.
   * @param senderId the id of the sender.
   * @param cawonce The cawonce to mark as used.
   */
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

    // Calculate the nonce: nonce = currentMap * 256 + bitIndex
    return (currentCawonceMap[senderId] * 256) + nextSlot;
  }

  /**
   * @dev Checks if a cawonce has been used for a specific senderId.
   * @param senderId the id of the sender.
   * @param cawonce The cawonce to check.
   * @return True if the cawonce has been used, false otherwise.
   */
  function isCawonceUsed(uint32 senderId, uint256 cawonce) public view returns (bool) {
    uint256 word = cawonce / 256;
    uint256 bit = cawonce % 256;
    return(usedCawonce[senderId][word] & (1 << bit)) != 0;
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

		require(data.actions.length <= 256, 'can only process 256 actions at once');
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
        emit ActionRejected(data.r[i], reason);
      } catch Panic(uint256 errorCode) {
        string memory errorCodeStr = Strings.toString(errorCode);
        emit ActionRejected(data.r[i], string(abi.encodePacked("Panic error code: ", errorCodeStr)));
      } catch (bytes memory lowLevelData) {
        emit ActionRejected(data.r[i], "low level exception");
      }
    }

    // Only allocate arrays after counting successful actions
    // bytes memory successfulActions;
    ActionData[] memory successfulActions = new ActionData[](successCount);

    uint32[] memory withdrawIds;
    uint256[] memory withdrawAmounts;
    if (withdrawCount > 0) {
      withdrawIds = new uint32[](withdrawCount);
      withdrawAmounts = new uint256[](withdrawCount);
    }

    // Second pass: Populate arrays based on bitmaps
    uint16 successIndex = 0;
    uint16 withdrawIndex = 0;

    for (uint16 i = 0; i < data.actions.length; i++) {
      if ((successBitmap & (1 << i)) != 0) {
        // This action was successful, so add it to the successfulActions array
        // successfulActions = abi.encodePacked(successfulActions, packActionData(data.actions[i]));
        successfulActions[successIndex] = data.actions[i];
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
    // if (successCount > 0) emit ActionsProcessed(successfulActions);
    if (successCount > 0) emit ActionsProcessed(abi.encode(successfulActions));

    // Call setWithdrawable with the withdraw tokens and amounts
    if (withdrawCount > 0) CawName.setWithdrawable{value: msg.value}(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken) public view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }

  function packActionData(ActionData memory action) internal pure returns (bytes memory) {
    // **1. Pack Fixed-Size Variables into a Single `uint256`**
    uint256 packed = (uint256(uint8(action.actionType)) << 248)
      | (uint256(action.senderId) << 216)
      | (uint256(action.receiverId) << 184)
      | (uint256(action.clientId) << 152)
      | (uint256(action.cawonce) << 120);

      // **2. Encode Fixed-Size Data**
      bytes memory fixedData = abi.encodePacked(packed);

      // **3. Determine the isTippingValidator Flag**
      // isTippingValidator is true if amounts.length == recipients.length + 1
      bool isTippingValidator = (action.amounts.length == action.recipients.length + 1);

      // **4. Pack the Flag and Length into a Byte**
      // Bit 3: isTippingValidator flag (1 if tipping validator)
      // Bits 2-0: recipientsLength (0-7)
      uint8 flagAndLength = uint8((isTippingValidator ? 1 : 0) << 3) | uint8(action.recipients.length & 0x07);

      // **5. Encode Flag and Length**
      bytes memory flagAndLengthData = abi.encodePacked(flagAndLength);

      // **6. Encode Recipients Array**
      bytes memory recipientsData;
      for (uint i = 0; i < action.recipients.length; i++)
        recipientsData = abi.encodePacked(recipientsData, action.recipients[i]);

      // **7. Encode Amounts Array**
      bytes memory amountsData;
      for (uint i = 0; i < action.amounts.length; i++)
        amountsData = abi.encodePacked(amountsData, action.amounts[i]);

      // **8. Encode Text String**
      bytes memory textBytes = bytes(action.text);
      bytes memory textData = abi.encodePacked(uint16(textBytes.length), textBytes);

      // **10. Concatenate All Data**
      return bytes.concat(fixedData, flagAndLengthData, recipientsData, amountsData, textData);
  }








}

