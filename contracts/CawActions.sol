// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../node_modules/@openzeppelin/contracts/utils/Context.sol";
import "../node_modules/@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "./interfaces/ISpend.sol";

contract CawActions is Context {

  enum ActionType{ CAW, LIKE, RECAW, FOLLOW }

  struct ActionData {
    ActionType actionType;
    uint64 senderId;
    uint64 receiverId;
    uint64[] tipRecipients;
    uint64 timestamp;
    address sender;
    uint256[] tips;
    bytes32 cawId;
    string text;
  }

  struct MultiActionData {
    ActionData[] actions;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
  }

  bytes32 public eip712DomainHash;

  mapping(uint64 => uint64) public processedActions;

  // tokenID => reducedSig => action
  mapping(uint64 => mapping(bytes32 => uint32)) public likes;

  // tokenID => reducedSig => action
  mapping(uint64 => mapping(bytes32 => bool)) public isVerified;

  mapping(uint64 => uint64) public followerCount;

  event ActionProcessed(uint64 senderId, bytes32 actionId);
  event ActionRejected(uint64 senderId, bytes32 actionId, string reason);

  ISpend CawName;

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    CawName = ISpend(_cawNames);
  }

  function processAction(uint64 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "caller is not the CawActions contract");

    verifySignature(v, r, s, action);

    if (action.actionType == ActionType.CAW)
      caw(action);
    else if (action.actionType == ActionType.LIKE)
      likeCaw(action);
    else if (action.actionType == ActionType.RECAW)
      reCaw(action);
    else if (action.actionType == ActionType.FOLLOW)
      followUser(action);
    else revert("Invalid action type");

    distributeTips(validatorId, action);
    isVerified[action.senderId][r] = true;
  }

  function distributeTips(uint64 validatorId, ActionData calldata action) internal {
    if (action.tips.length + action.tipRecipients.length == 0) return; // no tips

    require(
      action.tipRecipients.length == action.tips.length - 1,
      'The tips list must have exactly one more value than the tipRecipients list'
    ); // the last value in the tips array is given to the validator

    uint256 tipTotal = action.tips[action.tips.length-1];

    for (uint256 i = 0; i < action.tipRecipients.length; i++) {
      CawName.addWeiToBalance(action.tipRecipients[i], action.tips[i]);
      tipTotal += action.tips[i];
    }

    CawName.addWeiToBalance(validatorId, action.tips[action.tips.length-1]);
    CawName.spendAndDistributeWei(action.senderId, tipTotal, 0);
  }

  function verifyActions(uint64[] calldata senderIds, bytes32[] calldata actionIds) external view returns (bool[] memory){
    require(senderIds.length == actionIds.length, "senderIds and actionIds must have the same number of elements");
    bool[] memory verified;

    for (uint16 i = 0; i < actionIds.length; i++) 
      verified[i] = isVerified[senderIds[i]][actionIds[i]];

    return verified;
  }

  function caw(
    ActionData calldata data
  ) internal {
    require(bytes(data.text).length <= 420, 'text must be less than 420 characters');
    CawName.spendAndDistribute(data.senderId, 5000, 5000);
  }


  function likeCaw(
    ActionData calldata data
  ) internal {
    // Do we need this? it adds more gas to keep track. Should we allow users to 'unlike' as well?
    // require(likedBy[likeData.ownerId][likeData.cawId][likeData.senderId] == false, 'Caw has already been liked');

    // Can a user like their own caw? 
    // if so, what happens with the funds?

    CawName.spendAndDistribute(data.senderId, 2000, 400);
    CawName.addToBalance(data.receiverId, 1600);

    likes[data.receiverId][data.cawId] += 1;
  }

  function reCaw(
    ActionData calldata data
  ) internal {
    CawName.spendAndDistribute(data.senderId, 4000, 2000);
    CawName.addToBalance(data.receiverId, 2000);
  }

  function followUser(
    ActionData calldata data
  ) internal {
    CawName.spendAndDistribute(data.senderId, 30000, 6000);
    CawName.addToBalance(data.receiverId, 24000);

    followerCount[data.receiverId] += 1;
  }

  function verifySignature(
    uint8 v, bytes32 r, bytes32 s,
    ActionData calldata data
  ) internal view {
    require(!isVerified[data.senderId][r], 'this action has already been processed');
    bytes memory hash = abi.encode(
      keccak256("ActionData(uint8 actionType,uint64 senderId,uint64 receiverId,uint64[] tipRecipients,uint64 timestamp,uint256[] tips,address sender,bytes32 cawId,string text)"),
      data.actionType, data.senderId, data.receiverId,
      keccak256(abi.encodePacked(data.tipRecipients)), data.timestamp, 
      keccak256(abi.encodePacked(data.tips)),  data.sender, data.cawId,
      keccak256(bytes(data.text))
    );

    address signer = getSigner(hash, v, r, s);
    require(signer == CawName.ownerOf(data.senderId), "signer is not owner of this CawName");
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

  function processActions(uint64 validatorId, MultiActionData calldata data) external {
    uint8[] calldata v = data.v;
    bytes32[] calldata r = data.r;
    bytes32[] calldata s = data.s;
    uint16 processed;
    for (uint16 i=0; i < data.actions.length; i++) {
      try CawActions(this).processAction(validatorId, data.actions[i], v[i], r[i], s[i]) {
        emit ActionProcessed(data.actions[i].senderId, r[i]);
        processed += 1;
      } catch Error(string memory _err) {
        emit ActionRejected(data.actions[i].senderId, r[i], _err);
      }
    }
    processedActions[validatorId] += processed;
  }

}

