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

    uint256 private constant MAX_TEXT_LENGTH = 420;

    bytes32 public immutable eip712DomainHash;
    bytes32 public currentHash = bytes32("genesis");

    mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
    mapping(uint32 => uint256) public currentCawonceMap;

    event ActionsProcessed(ActionData[] actions);
    event ActionRejected(uint32 senderId, uint32 cawonce, string reason);

    CawNameL2 public immutable CawName;

    // Precomputed type hashes for EIP712
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
        "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint128[] amounts,string text)"
    );

    constructor(address _cawNames) {
        eip712DomainHash = generateDomainHash();
        CawName = CawNameL2(_cawNames);
    }

    function processAction(
        uint32 validatorId,
        ActionData calldata action,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal returns (bool success, string memory errorReason) {
        success = true;
        errorReason = "";

        if (isCawonceUsed(action.senderId, action.cawonce)) {
            success = false;
            errorReason = "Cawonce used already";
            return (success, errorReason);
        }

        if (!CawName.authenticated(action.clientId, action.senderId)) {
            success = false;
            errorReason = "User has not authenticated with this client";
            return (success, errorReason);
        }

        (bool sigValid, string memory sigError) = verifySignature(v, r, s, action);
        if (!sigValid) {
            success = false;
            errorReason = sigError;
            return (success, errorReason);
        }

        // First, get action cost and distribution amounts
        uint256 actionCost;
        uint256 amountToDistribute;
        (bool costSuccess, string memory costError, uint256 actionCostReturned, uint256 amountToDistributeReturned) = getActionCostAndDistribution(action);
        if (!costSuccess) {
            success = false;
            errorReason = costError;
            return (success, errorReason);
        }
        actionCost = actionCostReturned;
        amountToDistribute = amountToDistributeReturned;

        // Then, calculate the total amount to distribute directly to recipients
        uint256 totalDistributeAmount = calculateTotalDistributeAmount(action);
        uint256 totalAmountToSpend = actionCost + totalDistributeAmount;

        // Check if sender has enough balance
        uint256 senderBalance = CawName.cawBalanceOf(action.senderId);
        if (senderBalance < totalAmountToSpend) {
            success = false;
            errorReason = "Insufficient CAW balance";
            return (success, errorReason);
        }

        // Deduct total amount from sender and distribute amountToDistribute among all users
        (bool spendSuccess, string memory spendError) = CawName.spendAndDistribute(
            action.senderId,
            totalAmountToSpend,
            amountToDistribute
        );
        if (!spendSuccess) {
            success = false;
            errorReason = spendError;
            return (success, errorReason);
        }

        // Now execute the action (without further token deductions)
        (success, errorReason) = executeActionWithoutSpending(action);
        if (!success) {
            // Since tokens have already been deducted and distributed, we cannot refund
            // Ensure that executeActionWithoutSpending cannot fail at this point
            return (success, errorReason);
        }

        // Distribute the amounts to recipients
        (success, errorReason) = distributeAmounts(validatorId, action);
        if (!success) {
            // Handle distribution failure if needed
            return (success, errorReason);
        }

        useCawonce(action.senderId, action.cawonce);

        currentHash = keccak256(abi.encodePacked(currentHash, r));

        return (success, errorReason);
    }

    function getActionCostAndDistribution(
        ActionData calldata action
    ) internal pure returns (bool success, string memory errorReason, uint256 actionCost, uint256 amountToDistribute) {
        success = true;
        errorReason = "";
        actionCost = 0;
        amountToDistribute = 0;

        if (action.actionType == ActionType.CAW) {
            if (bytes(action.text).length > MAX_TEXT_LENGTH) {
                success = false;
                errorReason = "Text must be less than 420 characters";
                return (success, errorReason, 0, 0);
            }
            actionCost = 5000 * 10**18;
            amountToDistribute = 5000 * 10**18;
        } else if (action.actionType == ActionType.LIKE) {
            actionCost = 2000 * 10**18;
            amountToDistribute = 400 * 10**18;
        } else if (action.actionType == ActionType.RECAW) {
            actionCost = 4000 * 10**18;
            amountToDistribute = 2000 * 10**18;
        } else if (action.actionType == ActionType.FOLLOW) {
            if (action.senderId == action.receiverId) {
                success = false;
                errorReason = "Cannot follow yourself";
                return (success, errorReason, 0, 0);
            }
            actionCost = 30000 * 10**18;
            amountToDistribute = 6000 * 10**18;
        } else if (action.actionType == ActionType.WITHDRAW) {
            actionCost = 0; // Withdraw doesn't have an action cost
            amountToDistribute = 0;
        } else if (action.actionType == ActionType.UNLIKE || action.actionType == ActionType.UNFOLLOW || action.actionType == ActionType.NOOP) {
            actionCost = 0;
            amountToDistribute = 0;
        } else {
            success = false;
            errorReason = "Invalid action type";
            return (success, errorReason, 0, 0);
        }

        return (success, errorReason, actionCost, amountToDistribute);
    }

    function calculateTotalDistributeAmount(ActionData calldata action) internal pure returns (uint256 totalDistributeAmount) {
        totalDistributeAmount = 0;

        uint256 numAmounts = action.amounts.length;
        if (numAmounts == 0) {
            return totalDistributeAmount;
        }

        for (uint256 i = 0; i < numAmounts; ) {
            totalDistributeAmount += uint256(action.amounts[i]);
            unchecked {
              ++i;
            }
        }
    }

    function executeActionWithoutSpending(ActionData calldata action) internal returns (bool success, string memory errorReason) {
        success = true;
        errorReason = "";

        if (action.actionType == ActionType.CAW) {
            // No additional state changes needed for caw action
            return (success, errorReason);
        } else if (action.actionType == ActionType.LIKE) {
            CawName.addTokensToBalance(action.receiverId, 1600);
        } else if (action.actionType == ActionType.RECAW) {
            CawName.addTokensToBalance(action.receiverId, 2000);
        } else if (action.actionType == ActionType.FOLLOW) {
            CawName.addTokensToBalance(action.receiverId, 24000);
        } else if (action.actionType == ActionType.UNLIKE || action.actionType == ActionType.UNFOLLOW || action.actionType == ActionType.NOOP) {
            // No operation needed
            return (success, errorReason);
        } else if (action.actionType == ActionType.WITHDRAW) {
            (bool withdrawSuccess, string memory withdrawError) = CawName.withdraw(action.senderId, action.amounts[0]);
            if (!withdrawSuccess) {
                success = false;
                errorReason = withdrawError;
                return (success, errorReason);
            }
        } else {
            success = false;
            errorReason = "Invalid action type";
            return (success, errorReason);
        }

        return (success, errorReason);
    }

    function distributeAmounts(
        uint32 validatorId,
        ActionData calldata action
    ) internal returns (bool success, string memory errorReason) {
        success = true;
        errorReason = "";

        uint256 numRecipients = action.recipients.length;
        uint256 numAmounts = action.amounts.length;

        if (numAmounts != numRecipients) {
            if (numAmounts != numRecipients + 1) {
                success = false;
                errorReason = "Amounts and recipients mismatch";
                return (success, errorReason);
            }
        }

        if (numRecipients == 0 && numAmounts == 0) return (success, errorReason);

        bool isWithdrawal = action.actionType == ActionType.WITHDRAW;
        uint256 startIndex = isWithdrawal ? 1 : 0;

        // Distribute amounts to recipients
        for (uint256 i = startIndex; i < numRecipients; ) {
            CawName.addToBalance(action.recipients[i], action.amounts[i]);
            unchecked {
                ++i;
            }
        }

        // Add to validator
        CawName.addToBalance(validatorId, action.amounts[numAmounts - 1]);

        return (success, errorReason);
    }

  function verifySignature(
    uint8 v,
    bytes32 r,
    bytes32 s,
    ActionData calldata data
  ) public view returns (bool success, string memory errorReason) {
    success = true;
    errorReason = "";

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
    if (signer != CawName.ownerOf(data.senderId)) {
      success = false;
      errorReason = "Signer is not owner of this CawName";
      return (success, errorReason);
    }

    return (success, errorReason);
  }

  function useCawonce(uint32 senderId, uint256 cawonce) internal {
    uint256 word = cawonce >> 8; // Divide by 256
    uint256 bit = cawonce & 0xff; // Modulo 256
    uint256 usedCawonceWord = usedCawonce[senderId][word];
    usedCawonceWord |= (1 << bit);
    usedCawonce[senderId][word] = usedCawonceWord;

    if (usedCawonceWord == type(uint256).max) {
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
      unchecked {
        ++nextSlot;
      }
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

  function processActions(
    uint32 validatorId,
    MultiActionData calldata data,
    uint256 lzTokenAmountForWithdraws
  ) external payable {
    uint256 actionsLength = data.actions.length;
    require(actionsLength <= 256, "Cannot process more than 256 actions");

    uint16 successCount;
    uint16 withdrawCount;
    uint256 successBitmap = 0;
    uint256 withdrawBitmap = 0;

    for (uint16 i = 0; i < actionsLength; ) {
      (bool success, string memory errorReason) = processAction(
        validatorId,
        data.actions[i],
        data.v[i],
        data.r[i],
        data.s[i]
      );

      if (success) {
        successBitmap |= (1 << i);
        if (data.actions[i].actionType == ActionType.WITHDRAW) {
          withdrawBitmap |= (1 << i);
          unchecked {
            ++withdrawCount;
          }
        }
        unchecked {
          ++successCount;
        }
      } else {
        emit ActionRejected(data.actions[i].senderId, data.actions[i].cawonce, errorReason);
      }
      unchecked {
        ++i;
      }
    }

    if (successCount > 0) {
      ActionData[] memory successfulActions = new ActionData[](successCount);
      uint16 index = 0;
      for (uint16 i = 0; i < actionsLength; ) {
        if ((successBitmap & (1 << i)) != 0) {
          successfulActions[index] = data.actions[i];
          unchecked {
            ++index;
          }
        }
        unchecked {
          ++i;
        }
      }
      emit ActionsProcessed(successfulActions);
    }

    if (withdrawCount > 0) {
      uint32[] memory withdrawIds = new uint32[](withdrawCount);
      uint256[] memory withdrawAmounts = new uint256[](withdrawCount);
      uint16 index = 0;
      for (uint16 i = 0; i < actionsLength; ) {
        if ((withdrawBitmap & (1 << i)) != 0) {
          withdrawIds[index] = data.actions[i].senderId;
          withdrawAmounts[index] = data.actions[i].amounts[0];
          unchecked {
            ++index;
          }
        }
        unchecked {
          ++i;
        }
      }
      CawName.setWithdrawable{ value: msg.value }(withdrawIds, withdrawAmounts, lzTokenAmountForWithdraws);
    }
  }

  function withdrawQuote(
    uint32[] memory tokenIds,
    uint256[] memory amounts,
    bool payInLzToken
  ) public view returns (MessagingFee memory quote) {
    return CawName.withdrawQuote(tokenIds, amounts, payInLzToken);
  }
}

