// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Example: M-of-N multisig that holds a CawProfile NFT and authorizes
///         CawActions via ERC-1271. Owners independently approve the EIP-712
///         digest of a pending action; once `threshold` approvals exist,
///         isValidSignature returns the 1271 magic value and any caller can
///         submit the action through CawActions.processActions.
///
/// @dev    Uses Pattern B from CONTRACT_OWNED_PROFILES.md: approvals are
///         on-chain state, not signatures embedded in the action's sig blob.
///         The `sig` argument to isValidSignature is unused.
///
///         Out of scope (deliberately, to keep the example small):
///           - Owner add/remove (constructor sets the set; redeploy to change).
///           - Threshold changes.
///           - Per-digest expiry. Approved digests live forever until consumed
///             by CawActions or revoked manually. For production, add an
///             expiry timestamp at approval time.
///           - Replay across consume: see "Replay considerations" in the
///             contract body.
///           - Reentrancy guards on receive/withdraw flows: this contract
///             doesn't hold ETH and only forwards CAW via standard CAW actions.
contract CawMultisigProfile is IERC721Receiver {
  bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
  bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;

  /// @dev The owner set is fixed at construction. address => true if owner.
  mapping(address => bool) public isOwner;
  uint256 public ownerCount;
  uint256 public threshold;

  /// @dev digest => owner => approved.
  mapping(bytes32 => mapping(address => bool)) public approvedBy;
  /// @dev digest => approval count.
  mapping(bytes32 => uint256) public approvalCount;

  event OwnerApproved(bytes32 indexed digest, address indexed owner, uint256 newCount);
  event OwnerRevoked(bytes32 indexed digest, address indexed owner, uint256 newCount);

  modifier onlyOwner() {
    require(isOwner[msg.sender], "Not an owner");
    _;
  }

  constructor(address[] memory owners, uint256 _threshold) {
    require(owners.length > 0, "No owners");
    require(_threshold > 0 && _threshold <= owners.length, "Invalid threshold");

    for (uint256 i = 0; i < owners.length; i++) {
      address o = owners[i];
      require(o != address(0), "Zero owner");
      require(!isOwner[o], "Duplicate owner");
      isOwner[o] = true;
    }

    ownerCount = owners.length;
    threshold = _threshold;
  }

  // ============================================
  // ERC-721 receiver
  // ============================================

  /// @notice Required so CawProfile NFTs can be transferred in via
  ///         safeTransferFrom. CawProfile.transferAndSync uses plain
  ///         _transfer (not _safeTransfer), so this hook isn't strictly
  ///         required for that flow — but we accept either path.
  function onERC721Received(address, address, uint256, bytes calldata)
    external pure override returns (bytes4)
  {
    return IERC721Receiver.onERC721Received.selector;
  }

  // ============================================
  // Approval / revocation
  // ============================================

  /// @notice Approve the EIP-712 digest of a pending action. Caller must
  ///         independently compute the digest from the ActionData (or
  ///         ActionBatch) they intend to submit through CawActions.
  /// @dev    Computing the digest off-chain mirrors what an EOA owner of a
  ///         profile does today when they sign a CAW action — same hash, just
  ///         recorded in storage instead of returned as a sig.
  function approve(bytes32 digest) external onlyOwner {
    require(!approvedBy[digest][msg.sender], "Already approved");
    approvedBy[digest][msg.sender] = true;
    uint256 newCount = approvalCount[digest] + 1;
    approvalCount[digest] = newCount;
    emit OwnerApproved(digest, msg.sender, newCount);
  }

  /// @notice Withdraw an approval before the action is submitted. Useful if
  ///         an owner changes their mind or the action turns out to encode
  ///         the wrong intent.
  function revoke(bytes32 digest) external onlyOwner {
    require(approvedBy[digest][msg.sender], "No approval to revoke");
    approvedBy[digest][msg.sender] = false;
    uint256 newCount = approvalCount[digest] - 1;
    approvalCount[digest] = newCount;
    emit OwnerRevoked(digest, msg.sender, newCount);
  }

  // ============================================
  // ERC-1271
  // ============================================

  /// @notice Returns the 1271 magic value iff `hash` (the EIP-712 digest the
  ///         CawActions verifier passed in) has reached threshold approvals.
  /// @dev    Cheap by design — the gas-bounded staticcall in CawActions
  ///         (50k stipend) gives us plenty of headroom for one SLOAD plus a
  ///         comparison. `signature` is unused; approvals live in storage.
  ///
  /// Replay considerations:
  ///   The protocol's per-senderId cawonce bitmap prevents the *same action*
  ///   from being submitted twice. An approved digest cannot be reused for a
  ///   different action because the digest commits to (cawonce, senderId,
  ///   actionType, recipients, amounts, text, ...). We deliberately do NOT
  ///   clear `approvalCount` on consume — there's nothing to clear, since
  ///   the same digest can never authorize a second action.
  function isValidSignature(bytes32 hash, bytes calldata)
    external view returns (bytes4)
  {
    if (approvalCount[hash] >= threshold) return ERC1271_MAGIC_VALUE;
    return ERC1271_INVALID_VALUE;
  }
}
