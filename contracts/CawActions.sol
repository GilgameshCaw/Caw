// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Context.sol";
import "./CawNameL2.sol";

contract CawActions is Context {
  enum ActionType { CAW, LIKE, UNLIKE, RECAW, FOLLOW, UNFOLLOW, WITHDRAW, NOOP }

  // Define structs for each action type
  struct CawAction {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId; // Optional, can be 0
    uint32 receiverCawonce; // Optional, can be 0
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint128[] amounts;
    string text;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  struct CawInteraction {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 receiverCawonce;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint128[] amounts;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  struct UserInteraction {
    ActionType actionType;
    uint32 senderId;
    uint32 receiverId;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint128[] amounts;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  struct WithdrawAction {
    ActionType actionType;
    uint32 senderId;
    uint32 clientId;
    uint32 cawonce;
    uint32[] recipients;
    uint128[] amounts;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  bytes32 public immutable eip712DomainHash;
  bytes32 public currentHash = bytes32("genesis");

  mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
  mapping(uint32 => uint256) public currentCawonceMap;

  event ActionsProcessed(
    CawAction[] cawActions,
    CawInteraction[] cawInteractions,
    UserInteraction[] userInteractions,
    WithdrawAction[] withdrawActions
  );
  event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

  CawNameL2 public immutable CawName;

  // Precomputed type hashes for EIP712
  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );
  bytes32 private constant CAWACTION_TYPEHASH = keccak256(
    "CawAction(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts,string text)"
  );
  bytes32 private constant LIKEACTION_TYPEHASH = keccak256(
    "CawInteraction(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts)"
  );
  bytes32 private constant FOLLOWACTION_TYPEHASH = keccak256(
    "UserInteraction(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts)"
  );
  bytes32 private constant WITHDRAWACTION_TYPEHASH = keccak256(
    "WithdrawAction(uint8 actionType,uint32 senderId,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts)"
  );

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    CawName = CawNameL2(_cawNames);
  }

  function processActions(
    uint32 validatorId,
    CawAction[] calldata cawActions,
    CawInteraction[] calldata cawInteractions,
    UserInteraction[] calldata userInteractions,
    WithdrawAction[] calldata withdrawActions,
    uint256 lzTokenAmountForWithdraws
  ) external payable {
    CawAction[] memory successfulCawActions = processCawActions(validatorId, cawActions);
    CawInteraction[] memory successfulCawInteractions = processCawInteractions(validatorId, cawInteractions);
    UserInteraction[] memory successfulUserInteractions = processUserInteractions(validatorId, userInteractions);
    WithdrawAction[] memory successfulWithdrawActions = processWithdrawActions(validatorId, withdrawActions, lzTokenAmountForWithdraws);

    // Emit ActionsProcessed event with successful actions
    if (successfulCawActions.length > 0 || successfulUserInteractions.length > 0 || successfulCawInteractions.length > 0 || successfulWithdrawActions.length > 0)
      emit ActionsProcessed(
        successfulCawActions,
      successfulCawInteractions,
      successfulUserInteractions,
      successfulWithdrawActions
      );
  }

  function processCawActions(uint32 validatorId, CawAction[] calldata cawActions)
  internal
  returns (CawAction[] memory)
  {
    uint256 length = cawActions.length;
    CawAction[] memory successfulActions = new CawAction[](length);
    uint256 successCount = 0;

    for (uint256 i = 0; i < length; ) {
      try this._processCawAction(validatorId, cawActions[i]) {
        successfulActions[successCount] = cawActions[i];
        unchecked {
          ++successCount;
        }
      } catch Error(string memory reason) {
        emit ActionRejected(cawActions[i].senderId, cawActions[i].cawonce, reason);
      } catch (bytes memory) {
        emit ActionRejected(cawActions[i].senderId, cawActions[i].cawonce, "Low-level exception");
      }
      unchecked {
        ++i;
      }
    }

    // Trim the successfulActions array
    assembly {
      mstore(successfulActions, successCount)
    }
    return successfulActions;
  }

  function processCawInteractions(uint32 validatorId, CawInteraction[] calldata cawInteractions)
  internal
  returns (CawInteraction[] memory)
  {
    uint256 length = cawInteractions.length;
    CawInteraction[] memory successfulActions = new CawInteraction[](length);
    uint256 successCount = 0;

    for (uint256 i = 0; i < length; ) {
      try this._processCawInteraction(validatorId, cawInteractions[i]) {
        successfulActions[successCount] = cawInteractions[i];
        unchecked {
          ++successCount;
        }
      } catch Error(string memory reason) {
        emit ActionRejected(cawInteractions[i].senderId, cawInteractions[i].cawonce, reason);
      } catch (bytes memory) {
        emit ActionRejected(cawInteractions[i].senderId, cawInteractions[i].cawonce, "Low-level exception");
      }
      unchecked {
        ++i;
      }
    }

    // Trim the successfulActions array
    assembly {
      mstore(successfulActions, successCount)
    }
    return successfulActions;
  }

  function processUserInteractions(uint32 validatorId, UserInteraction[] calldata userInteractions)
  internal
  returns (UserInteraction[] memory)
  {
    uint256 length = userInteractions.length;
    UserInteraction[] memory successfulActions = new UserInteraction[](length);
    uint256 successCount = 0;

    for (uint256 i = 0; i < length; ) {
      try this._processUserInteraction(validatorId, userInteractions[i]) {
        successfulActions[successCount] = userInteractions[i];
        unchecked {
          ++successCount;
        }
      } catch Error(string memory reason) {
        emit ActionRejected(userInteractions[i].senderId, userInteractions[i].cawonce, reason);
      } catch (bytes memory) {
        emit ActionRejected(userInteractions[i].senderId, userInteractions[i].cawonce, "Low-level exception");
      }
      unchecked {
        ++i;
      }
    }

    // Trim the successfulActions array
    assembly {
      mstore(successfulActions, successCount)
    }
    return successfulActions;
  }

  function processWithdrawActions(uint32 validatorId, WithdrawAction[] calldata withdrawActions, uint256 lzTokenAmountForWithdraws)
  internal
  returns (WithdrawAction[] memory)
  {
    uint256 length = withdrawActions.length;
    WithdrawAction[] memory successfulActions = new WithdrawAction[](length);
    uint256[] memory withdrawAmounts = new uint256[](length);
    uint32[] memory withdrawIds = new uint32[](length);
    uint256 successCount = 0;

    for (uint256 i = 0; i < length; ) {
      try this._processWithdrawAction(validatorId, withdrawActions[i]) {
        successfulActions[successCount] = withdrawActions[i];
        withdrawAmounts[successCount] = withdrawActions[i].amounts[0];
        withdrawIds[successCount] = withdrawActions[i].recipients[0];
        unchecked {
          ++successCount;
        }
      } catch Error(string memory reason) {
        emit ActionRejected(withdrawActions[i].senderId, withdrawActions[i].cawonce, reason);
      } catch (bytes memory) {
        emit ActionRejected(withdrawActions[i].senderId, withdrawActions[i].cawonce, "Low-level exception");
      }
      unchecked {
        ++i;
      }
    }

    // Trim the successfulActions array
    assembly {
      mstore(successfulActions, successCount)
    }

    if (successCount > 0) {
      assembly {
        mstore(withdrawAmounts, successCount)
        mstore(withdrawIds, successCount)
      }
      CawName.setWithdrawable{ value: msg.value }(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
    }

    return successfulActions;
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken)
  public view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }

  // Internal processing functions
  function _processCawAction(uint32 validatorId, CawAction calldata data) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    require(!isCawonceUsed(data.senderId, data.cawonce), "Cawonce already used");
    require(CawName.authenticated(data.clientId, data.senderId), "User not authenticated");
    verifyCawSignature(data);

    require(bytes(data.text).length <= 420, "Text exceeds 420 characters");
    CawName.spendAndDistributeTokens(data.senderId, 5000, 5000);

    distributeAmounts(validatorId, data.senderId, data.recipients, data.amounts, false);

    useCawonce(data.senderId, data.cawonce);
    currentHash = keccak256(abi.encodePacked(currentHash, data.r));
  }

  function _processCawInteraction(uint32 validatorId, CawInteraction calldata data) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    require(!isCawonceUsed(data.senderId, data.cawonce), "Cawonce already used");
    require(CawName.authenticated(data.clientId, data.senderId), "User not authenticated");
    verifyCawInteractionSignature(data);

    if (data.actionType == ActionType.LIKE) {
      CawName.spendAndDistributeTokens(data.senderId, 2000, 400);
      CawName.addTokensToBalance(data.receiverId, 1600);
    } else if (data.actionType == ActionType.RECAW) {
      CawName.spendAndDistributeTokens(data.senderId, 4000, 2000);
      CawName.addTokensToBalance(data.receiverId, 2000);
    } // else if UNLIKE, no funds will be sent or distributed

    distributeAmounts(validatorId, data.senderId, data.recipients, data.amounts, false);

    useCawonce(data.senderId, data.cawonce);
    currentHash = keccak256(abi.encodePacked(currentHash, data.r));
  }

  function _processUserInteraction(uint32 validatorId, UserInteraction calldata data) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    require(!isCawonceUsed(data.senderId, data.cawonce), "Cawonce already used");
    require(CawName.authenticated(data.clientId, data.senderId), "User not authenticated");
    verifyUserInteractionSignature(data);

    if (data.actionType == ActionType.FOLLOW) {
      require(data.senderId != data.receiverId, "Cannot follow yourself");
      CawName.spendAndDistributeTokens(data.senderId, 30000, 6000);
      CawName.addTokensToBalance(data.receiverId, 24000);
    } // else if UNFOLLOW, no funds will be sent or distributed


    distributeAmounts(validatorId, data.senderId, data.recipients, data.amounts, false);

    useCawonce(data.senderId, data.cawonce);
    currentHash = keccak256(abi.encodePacked(currentHash, data.r));
  }

  function _processWithdrawAction(uint32 validatorId, WithdrawAction calldata data) external {
    require(address(this) == _msgSender(), "Caller must be CawActions contract");
    require(!isCawonceUsed(data.senderId, data.cawonce), "Cawonce already used");
    require(CawName.authenticated(data.clientId, data.senderId), "User not authenticated");
    verifyWithdrawSignature(data);

    CawName.withdraw(data.senderId, data.amounts[0]);

    distributeAmounts(validatorId, data.senderId, data.recipients, data.amounts, true);

    useCawonce(data.senderId, data.cawonce);
    currentHash = keccak256(abi.encodePacked(currentHash, data.r));
  }

  // Signature verification functions for each action type
  function verifyCawSignature(CawAction calldata data) public view {
    bytes32 structHash = keccak256(
      abi.encode(
        CAWACTION_TYPEHASH,
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

    address signer = getSigner(structHash, data.v, data.r, data.s);
    require(signer == CawName.ownerOf(data.senderId), "Invalid signer");
  }

  function verifyCawInteractionSignature(CawInteraction calldata data) public view {
    bytes32 structHash = keccak256(
      abi.encode(
        LIKEACTION_TYPEHASH,
        data.actionType,
        data.senderId,
        data.receiverId,
        data.receiverCawonce,
        data.clientId,
        data.cawonce,
        keccak256(abi.encodePacked(data.recipients)),
        keccak256(abi.encodePacked(data.amounts))
    )
    );

    address signer = getSigner(structHash, data.v, data.r, data.s);
    require(signer == CawName.ownerOf(data.senderId), "Invalid signer");
  }

  function verifyUserInteractionSignature(UserInteraction calldata data) public view {
    bytes32 structHash = keccak256(
      abi.encode(
        FOLLOWACTION_TYPEHASH,
        data.actionType,
        data.senderId,
        data.receiverId,
        data.clientId,
        data.cawonce,
        keccak256(abi.encodePacked(data.recipients)),
        keccak256(abi.encodePacked(data.amounts))
    )
    );

    address signer = getSigner(structHash, data.v, data.r, data.s);
    require(signer == CawName.ownerOf(data.senderId), "Invalid signer");
  }

  function verifyWithdrawSignature(WithdrawAction calldata data) public view {
    bytes32 structHash = keccak256(
      abi.encode(
        WITHDRAWACTION_TYPEHASH,
        data.actionType,
        data.senderId,
        data.clientId,
        data.cawonce,
        keccak256(abi.encodePacked(data.recipients)),
        keccak256(abi.encodePacked(data.amounts))
    )
    );

    address signer = getSigner(structHash, data.v, data.r, data.s);
    require(signer == CawName.ownerOf(data.senderId), "Invalid signer");
  }

  function distributeAmounts(
    uint32 validatorId,
    uint32 senderId,
    uint32[] calldata recipients,
    uint128[] calldata amounts,
    bool isWithdrawal
  ) internal {
    uint256 numRecipients = recipients.length;
    uint256 numAmounts = amounts.length;

    if (numRecipients == 0 && numAmounts == 0) return;

    if (numAmounts != numRecipients)
      require(numAmounts == numRecipients + 1, "Amounts and recipients mismatch");

    uint256 amountTotal = amounts[numAmounts - 1];
    uint256 startIndex = isWithdrawal ? 1 : 0;


    for (uint256 i = startIndex; i < numRecipients; ) {
      CawName.addToBalance(recipients[i], amounts[i]);
      amountTotal += amounts[i];
      unchecked {
        ++i;
      }
    }

    CawName.spendAndDistribute(senderId, amountTotal, 0);
    CawName.addToBalance(validatorId, amounts[numAmounts - 1]);
  }

  // Utility functions
  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce >> 8; // Divide by 256
    uint256 bit = cawonce & 0xff; // Modulo 256
    usedCawonce[senderId][word] |= (1 << bit);
    if (usedCawonce[senderId][word] == type(uint256).max) {
      currentCawonceMap[senderId] = word + 1;
    }
  }

  function isCawonceUsed(uint32 senderId, uint256 cawonce) public view returns (bool) {
    uint256 word = cawonce >> 8;
    uint256 bit = cawonce & 0xff;
    return (usedCawonce[senderId][word] & (1 << bit)) != 0;
  }

  function nextCawonce(uint32 senderId) public view returns (uint256) {
    uint256 currentMap = currentCawonceMap[senderId];
    uint256 word = usedCawonce[senderId][currentMap];
    if (word == 0) return currentMap * 256;

    uint256 nextSlot;
    for (nextSlot = 0; nextSlot < 256; ) {
      if (((1 << nextSlot) & word) == 0) break;
      unchecked {
        ++nextSlot;
      }
    }
    return (currentMap * 256) + nextSlot;
  }

  function getSigner(
    bytes32 structHash,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public view returns (address) {
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
}

