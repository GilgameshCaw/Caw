// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
// CawActionsERC1271 — ERC-1271 signature verification sibling for CawActions
// =============================================================================
//
// Handles variable-length signatures from contract-owned CawProfile tokens.
//
// packedActions format (per group):
//   [2 bytes] uint16  groupSize
//   [N bytes] raw packed action bytes (same per-action wire layout as
//             CawActions.processActions, but no top-level actionCount header)
//
// sigs[g]  = raw ERC-1271 signature blob for group g.
// rs[g]    = keccak256(sigs[g]) — hash-chain anchor.
// =============================================================================

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "./CawProfileL2.sol";
import "./interfaces/ICawActions.sol";

contract CawActionsERC1271 {

  ICawActions   public immutable cawActions;
  CawProfileL2  public immutable cawProfile;

  uint256 private constant ERC1271_GAS_LIMIT = 50_000;
  bytes4  private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

  bytes32 private constant ACTIONDATA_TYPEHASH = keccak256(
    "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
  );
  bytes32 private constant ACTIONBATCH_TYPEHASH = keccak256(
    "ActionBatch(uint32 senderId,uint32 firstCawonce,uint32 actionCount,bytes32 actionsHash)"
  );

  uint8 private constant ACTION_WITHDRAW = 6;

  event ActionsProcessed(
    uint32 indexed networkId,
    uint32 indexed validatorId,
    uint16 actionCount,
    bytes32 batchHash
  );

  /// @dev Per-call context. Grouping fields that are constant across the call
  ///      (validatorId, domainHash) and mutable cursor state (pos, firstNetworkId,
  ///      seenFirst) into one struct lets _processGroup receive two arguments
  ///      instead of six, staying under the viaIR stack-depth limit.
  struct BatchCtx {
    uint32  validatorId;
    bytes32 domainHash;
    uint256 pos;
    uint32  firstNetworkId;
    bool    seenFirst;
    uint256 withdrawCount;
    uint32[]  withdrawIds;
    uint256[] withdrawAmounts;
  }

  constructor(address _cawActions) {
    cawActions = ICawActions(_cawActions);
    cawProfile = CawProfileL2(ICawActions(_cawActions).cawProfile());
  }

  /// @notice Process a batch of actions signed by ERC-1271 contract owners.
  function processActionsERC1271(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes[] calldata sigs,
    bytes32[] calldata rs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) external payable {
    uint256 numGroups = sigs.length;
    require(numGroups > 0, "No groups");
    require(rs.length == numGroups, "rs length mismatch");

    BatchCtx memory ctx;
    ctx.validatorId      = validatorId;
    ctx.domainHash       = cawActions.eip712DomainHash();
    ctx.withdrawIds      = new uint32[](256);
    ctx.withdrawAmounts  = new uint256[](256);

    for (uint256 g = 0; g < numGroups; ) {
      require(rs[g] == keccak256(sigs[g]), "rs commitment mismatch");
      _processGroup(packedActions, sigs[g], rs[g], ctx);
      unchecked { ++g; }
    }

    require(ctx.pos == packedActions.length, "Trailing bytes");

    if (ctx.withdrawCount > 0) {
      _executeWithdrawals(ctx, withdrawFee, withdrawLzTokenAmount);
    }
  }

  function _executeWithdrawals(
    BatchCtx memory ctx,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
  ) internal {
    uint256 n = ctx.withdrawCount;
    uint32[]  memory wIds  = new uint32[](n);
    uint256[] memory wAmts = new uint256[](n);
    for (uint256 i = 0; i < n; ) {
      wIds[i]  = ctx.withdrawIds[i];
      wAmts[i] = ctx.withdrawAmounts[i];
      unchecked { ++i; }
    }
    require(withdrawFee > 0 || cawProfile.bypassLZ(), "withdrawFee required");
    cawProfile.setWithdrawable{value: withdrawFee}(wIds, wAmts, withdrawLzTokenAmount);
  }

  function _processGroup(
    bytes calldata packedActions,
    bytes memory sig,
    bytes32 r,
    BatchCtx memory ctx
  ) internal {
    uint256 pos = ctx.pos;

    // 2-byte groupSize header.
    uint256 groupSize;
    assembly { groupSize := shr(240, calldataload(add(packedActions.offset, pos))) }
    pos += 2;
    require(groupSize > 0, "Empty group");

    uint256 groupStart = pos;

    // Read key fields from first action header, track WITHDRAWs.
    uint32 senderId0  = _readSenderId(packedActions, pos);
    uint32 networkId0 = _readNetworkId(packedActions, pos);
    _trackWithdraw0(packedActions, pos, ctx);

    // Walk all actions: collect per-action hashes + remaining WITHDRAWs.
    bytes32 actionsHash;
    (pos, actionsHash) = _walkGroup(packedActions, pos, groupSize, ctx);

    ctx.pos = pos;

    // Network invariant check.
    if (!ctx.seenFirst) {
      ctx.firstNetworkId = networkId0;
      ctx.seenFirst = true;
    } else {
      require(networkId0 == ctx.firstNetworkId, "Mixed networks");
    }

    _applyGroup(packedActions, sig, r, groupStart, pos, groupSize, senderId0, actionsHash, ctx);
  }

  function _applyGroup(
    bytes calldata packedActions,
    bytes memory sig,
    bytes32 r,
    uint256 groupStart,
    uint256 groupEnd,
    uint256 groupSize,
    uint32  senderId0,
    bytes32 actionsHash,
    BatchCtx memory ctx
  ) internal {
    uint32 cawonce0 = _readCawonce(packedActions, groupStart);

    bytes32 digest = _computeDigest(
      ctx.domainHash, packedActions, groupStart,
      groupSize, senderId0, cawonce0, actionsHash
    );

    address owner = cawProfile.ownerOf(senderId0);
    _verifyERC1271(owner, digest, sig, groupSize == 1);

    bytes calldata groupBytes = packedActions[groupStart:groupEnd];
    cawActions.processGroupSingle(
      ctx.validatorId, groupBytes, 0, r, 0, uint16(groupSize), owner
    );

    emit ActionsProcessed(
      ctx.firstNetworkId, ctx.validatorId, uint16(groupSize), keccak256(groupBytes)
    );
  }

  /// @dev Walk `groupSize` actions from `pos`, collecting per-action hashes
  ///      and accumulating WITHDRAW entries (indices 1+ only; index 0 handled
  ///      by caller via _trackWithdraw0).
  function _walkGroup(
    bytes calldata packed,
    uint256 pos,
    uint256 groupSize,
    BatchCtx memory ctx
  ) internal pure returns (uint256 endPos, bytes32 actionsHash) {
    bytes32[] memory hashes = new bytes32[](groupSize);
    for (uint256 i = 0; i < groupSize; ) {
      uint256 sliceStart = pos;
      uint256 w;
      assembly { w := calldataload(add(packed.offset, pos)) }
      uint8   at_i = uint8(w >> 248);
      uint256 rc_i = (w >> 80) & 0xFF;

      pos = _skipAction(packed, pos);
      hashes[i] = keccak256(packed[sliceStart:pos]);

      if (i > 0 && at_i == ACTION_WITHDRAW) {
        uint256 firstAmt = _readFirstAmountAt(packed, sliceStart + 23 + rc_i * 4);
        uint32 sid_i;
        assembly { sid_i := and(shr(216, calldataload(add(packed.offset, sliceStart))), 0xFFFFFFFF) }
        _recordWithdraw(ctx, sid_i, firstAmt * 10**18);
      }

      unchecked { ++i; }
    }
    endPos = pos;
    actionsHash = keccak256(abi.encodePacked(hashes));
  }

  function _computeDigest(
    bytes32 domainHash,
    bytes calldata packed,
    uint256 groupStart,
    uint256 groupSize,
    uint32 senderId,
    uint32 firstCawonce,
    bytes32 actionsHash
  ) internal pure returns (bytes32) {
    bytes32 structHash = groupSize == 1
      ? _computeActionDataStructHash(packed, groupStart)
      : keccak256(abi.encode(
          ACTIONBATCH_TYPEHASH, senderId, firstCawonce, uint32(groupSize), actionsHash
        ));
    return keccak256(abi.encodePacked("\x19\x01", domainHash, structHash));
  }

  function _computeActionDataStructHash(
    bytes calldata packed,
    uint256 start
  ) internal pure returns (bytes32 structHash) {
    uint8   actionType; uint32 senderId; uint32 receiverId;
    uint32  receiverCawonce; uint32 networkId; uint32 cawonce;
    uint256 rc; uint256 ac;
    {
      uint256 w;
      assembly { w := calldataload(add(packed.offset, start)) }
      actionType      = uint8(w >> 248);
      senderId        = uint32((w >> 216) & 0xFFFFFFFF);
      receiverId      = uint32((w >> 184) & 0xFFFFFFFF);
      receiverCawonce = uint32((w >> 152) & 0xFFFFFFFF);
      networkId       = uint32((w >> 120) & 0xFFFFFFFF);
      cawonce         = uint32((w >> 88)  & 0xFFFFFFFF);
      rc              = (w >> 80) & 0xFF;
      ac              = (w >> 72) & 0xFF;
    }

    uint32[] memory recipients = new uint32[](rc);
    {
      uint256 rOff = start + 23;
      for (uint256 i = 0; i < rc; ) {
        uint32 r_;
        assembly { r_ := and(shr(224, calldataload(add(packed.offset, add(rOff, mul(i, 4))))), 0xFFFFFFFF) }
        recipients[i] = r_;
        unchecked { ++i; }
      }
    }

    uint64[] memory amounts = new uint64[](ac);
    {
      uint256 aOff = start + 23 + rc * 4;
      for (uint256 i = 0; i < ac; ) {
        uint64 a_;
        assembly { a_ := and(shr(192, calldataload(add(packed.offset, add(aOff, mul(i, 8))))), 0xFFFFFFFFFFFFFFFF) }
        amounts[i] = a_;
        unchecked { ++i; }
      }
    }

    uint256 textOff = start + 23 + rc * 4 + ac * 8;
    uint256 tl;
    assembly { tl := shr(240, calldataload(add(packed.offset, textOff))) }
    bytes calldata text = packed[textOff + 2 : textOff + 2 + tl];

    bytes32 recipHash = keccak256(abi.encodePacked(recipients));
    bytes32 amtHash   = keccak256(abi.encodePacked(amounts));
    bytes32 textHash  = keccak256(text);
    bytes32 typeHash  = ACTIONDATA_TYPEHASH;

    assembly {
      let buf := mload(0x40)
      mstore(buf,             typeHash)
      mstore(add(buf, 0x20),  actionType)
      mstore(add(buf, 0x40),  senderId)
      mstore(add(buf, 0x60),  receiverId)
      mstore(add(buf, 0x80),  receiverCawonce)
      mstore(add(buf, 0xA0),  networkId)
      mstore(add(buf, 0xC0),  cawonce)
      mstore(add(buf, 0xE0),  recipHash)
      mstore(add(buf, 0x100), amtHash)
      mstore(add(buf, 0x120), textHash)
      structHash := keccak256(buf, 0x140)
    }
  }

  function _verifyERC1271(
    address owner,
    bytes32 digest,
    bytes memory sig,
    bool isSingle
  ) internal view {
    (bool ok, bytes memory ret) = owner.staticcall{gas: ERC1271_GAS_LIMIT}(
      abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig)
    );
    require(
      ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC_VALUE,
      isSingle ? "Invalid signature" : "Batch sig invalid"
    );
  }

  function _readSenderId(bytes calldata packed, uint256 pos) internal pure returns (uint32 v) {
    assembly { v := and(shr(216, calldataload(add(packed.offset, pos))), 0xFFFFFFFF) }
  }

  function _readNetworkId(bytes calldata packed, uint256 pos) internal pure returns (uint32 v) {
    assembly { v := and(shr(120, calldataload(add(packed.offset, pos))), 0xFFFFFFFF) }
  }

  function _readCawonce(bytes calldata packed, uint256 pos) internal pure returns (uint32 v) {
    assembly { v := and(shr(88, calldataload(add(packed.offset, pos))), 0xFFFFFFFF) }
  }

  /// @dev Track a WITHDRAW at position 0 in a group, if applicable.
  function _trackWithdraw0(bytes calldata packed, uint256 pos, BatchCtx memory ctx) internal pure {
    uint256 w;
    assembly { w := calldataload(add(packed.offset, pos)) }
    if (uint8(w >> 248) == ACTION_WITHDRAW) {
      uint256 rc = (w >> 80) & 0xFF;
      uint256 firstAmt = _readFirstAmountAt(packed, pos + 23 + rc * 4);
      _recordWithdraw(ctx, uint32((w >> 216) & 0xFFFFFFFF), firstAmt * 10**18);
    }
  }

  /// @dev Append one WITHDRAW entry to ctx, enforcing the 256-slot cap.
  function _recordWithdraw(BatchCtx memory ctx, uint32 id, uint256 amount) internal pure {
    require(ctx.withdrawCount < 256, "Too many withdraws");
    ctx.withdrawIds[ctx.withdrawCount]     = id;
    ctx.withdrawAmounts[ctx.withdrawCount] = amount;
    unchecked { ++ctx.withdrawCount; }
  }

  function _skipAction(bytes calldata packed, uint256 pos) internal pure returns (uint256) {
    uint256 rc; uint256 ac;
    {
      uint256 w;
      assembly { w := calldataload(add(packed.offset, pos)) }
      rc = (w >> 80) & 0xFF;
      ac = (w >> 72) & 0xFF;
    }
    uint256 amtEnd = pos + 23 + rc * 4 + ac * 8;
    uint256 tl;
    assembly { tl := shr(240, calldataload(add(packed.offset, amtEnd))) }
    return amtEnd + 2 + tl;
  }

  function _readFirstAmountAt(bytes calldata packed, uint256 amtOff) internal pure returns (uint256 v) {
    assembly {
      v := and(shr(192, calldataload(add(packed.offset, amtOff))), 0xFFFFFFFFFFFFFFFF)
    }
  }
}
