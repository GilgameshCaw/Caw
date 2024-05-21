// contracts/CawActions.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "./interfaces/ISpend.sol";

contract CawIndexing is Context {

  enum ActionType{ CAW, LIKE, RECAW, FOLLOW, REQUEST_VALIDATOR_TOKENS }

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

  mapping(uint64 => bool) public hasFunded;

  // tokenID => reducedSig => action
  mapping(uint64 => mapping(bytes32 => uint32)) public likes;

  mapping(bytes32 => ActionData) public actions;
  mapping(bytes32 => bytes32[]) public recaws;

  mapping(uint64 => bytes32[]) public caws;
  mapping(uint64 => bytes32[]) public feeds;

  mapping(string => bytes32[]) public hashtags;
  mapping(string => bytes32[]) public mentions;

  mapping(uint64 => uint64[]) public followerIds;
  mapping(uint64 => uint64[]) public followingIds;

  // tokenID => reducedSig => action
  mapping(uint64 => mapping(bytes32 => bool)) public isVerified;

  mapping(uint64 => uint64) public followerCount;

  event ActionIndexed(uint64 senderId, bytes32 actionId);
  event ActionRejected(uint64 senderId, bytes32 actionId, string reason);

  ISpend CawName;

  constructor(address _cawNames) {
    eip712DomainHash = generateDomainHash();
    CawName = ISpend(_cawNames);
  }

  function indexAction(uint64 validatorId, ActionData calldata action, uint8 v, bytes32 r, bytes32 s) external {
    require(address(this) == _msgSender(), "caller is not the CawActions contract");

    verifySignature(v, r, s, action);

    if (action.actionType == ActionType.CAW)
      indexCaw(r, action);
    else if (action.actionType == ActionType.LIKE)
      indexLike(r, action);
    else if (action.actionType == ActionType.RECAW)
      indexReCaw(r, action);
    else if (action.actionType == ActionType.FOLLOW)
      indexFollow(r, action);
    else if (action.actionType == ActionType.REQUEST_VALIDATOR_TOKENS)
      transferValidatorTokens(action);
    else revert("Invalid action type");

    isVerified[action.senderId][r] = true;
  }

  function transferValidatorTokens(ActionData calldata data) internal {
    if (!hasFunded[data.senderId])
      payable(data.sender).transfer(1 ether);
  }

  function verifyActions(uint64[] calldata senderIds, bytes32[] calldata actionIds) external view returns (bool[] memory){
    require(senderIds.length == actionIds.length, "senderIds and actionIds must have the same number of elements");
    bool[] memory verified;

    for (uint16 i = 0; i < actionIds.length; i++) 
      verified[i] = isVerified[senderIds[i]][actionIds[i]];

    return verified;
  }

  function indexCaw(
    bytes32 actionId,
    ActionData calldata data
  ) internal {
    caws[data.senderId].push(actionId);
    for (uint256 index = 0; index < followerIds[data.senderId].length; index++) {
      feeds[followerIds[data.senderId][index]].push(actionId);
      indexTagsAndMentions(data.text, actionId);
    }
  }

  function indexLike(
    bytes32 actionId,
    ActionData calldata data
  ) internal {
    // Do we need this? it adds more gas to keep track. Should we allow users to 'unlike' as well?
    // require(likedBy[likeData.ownerId][likeData.cawId][likeData.senderId] == false, 'Caw has already been liked');

    // Can a user like their own caw? 
    // if so, what happens with the funds?


    likes[data.receiverId][data.cawId] += 1;
  }

  function indexReCaw(
    bytes32 actionId,
    ActionData calldata data
  ) internal {
    recaws[data.cawId].push(actionId);
    caws[data.senderId].push(actionId);
  }

  function indexFollow(
    bytes32 actionId,
    ActionData calldata data
  ) internal {
    followingIds[data.senderId].push(data.receiverId);
    followerIds[data.receiverId].push(data.senderId);
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

  function indexActions(uint64 validatorId, MultiActionData calldata data) external {
    uint8[] calldata v = data.v;
    bytes32[] calldata r = data.r;
    bytes32[] calldata s = data.s;
    uint16 processed;
    for (uint16 i=0; i < data.actions.length; i++) {
      try CawIndexing(this).indexAction(validatorId, data.actions[i], v[i], r[i], s[i]) {
        emit ActionIndexed(data.actions[i].senderId, r[i]);
        actions[r[i]] = data.actions[i];
        processed += 1;
      } catch Error(string memory _err) {
        emit ActionRejected(data.actions[i].senderId, r[i], _err);
      }
    }
  }

  // Function to check for hashtags and mentions in a given string
  function indexTagsAndMentions(string memory text, bytes32 actionId) internal {
    bytes memory textBytes = bytes(text);
    uint256 length = textBytes.length;

    string memory currentToken = "";

    for (uint256 i = 0; i < length; i++) {
      bytes1 char = textBytes[i];
      if (char == " " || char == "\n") {
        indexByToken(currentToken, actionId);
        currentToken = "";
      } else currentToken = string(abi.encodePacked(currentToken, char));
    }

    // Handle the last token if the string doesn't end with a space or newline
    indexByToken(currentToken, actionId);
  }

  // Function to process a token and update mappings if it's a hashtag or mention
  function indexByToken(string memory token, bytes32 actionId) internal {
    if (bytes(token).length == 0) return;
    if (bytes(token)[0] == "#")
      hashtags[token].push(actionId);
    else if (bytes(token)[0] == "@")
      mentions[token].push(actionId);
  }

}


