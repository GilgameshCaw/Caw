// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct CawNetwork {
  uint32 id;
  uint32 storageChainEid; // The L2 chain where this network's actions are processed
  string name;
  address feeAddress;
  address ownerAddress;
  uint256 withdrawFee;
  uint256 depositFee;
  uint256 mintFee;
  uint256 authFee;
  // Block at which this network was created, so indexers can scope their
  // historical event scan to [creationBlock, current] instead of scanning
  // the entire contract history. Set once in createNetwork(); never changes.
  uint256 creationBlock;
  // Per-network upper bound on every individual fee (withdraw/deposit/auth/
  // mint). Set once at createNetwork() time and can only be *lowered* via
  // lowerFeeCeiling() — never raised. Every fee setter rejects values that
  // would exceed this ceiling, so a network owner can publicly commit to a
  // ceiling and users can rely on it without trusting future behavior.
  uint256 feeCeiling;
}

/**
 * @title CawNetworkManager
 * @notice Registry of networks and their per-instance API endpoints.
 * @dev Replication destinations used to live here too — pushed to L2 over LayerZero
 *      via CawProfile. That is gone. Per-validator replication targets are now
 *      configuration on the validator (REPLICATE_NETWORK_IDS env), not chain state.
 *      The on-chain part is just identity, fees, owner, storageChainEid, and
 *      instance registry.
 */
contract CawNetworkManager {

  address public immutable buyAndBurnAddress;

  uint32 public nextNetworkId = 1;
  mapping(uint32 => CawNetwork) public networks;

  // Per-network lockdown flags. A network owner can independently freeze fee
  // changes, ownership changes, or both. This lets a network commit to "trust
  // minimized" status (renounce-equivalent) while keeping access to the gas
  // override below — necessary because the protocol has no admin to fix
  // future cross-chain gas miscalibrations.
  mapping(uint32 => bool) public networkFeesLocked;
  mapping(uint32 => bool) public networkOwnershipLocked;

  // Per-network, per-selector additive gas override for cross-chain LZ
  // messages. CawProfile reads this and adds it on top of the hardcoded
  // gasLimitFor baseline. Strictly ratcheting (only goes up), hard-capped
  // at MAX_GAS_OVERRIDE so a compromised network owner can't grief their
  // users with arbitrarily expensive messages.
  //
  // Why per-network (not global): grief surface is bounded to a single
  // network's users, not the whole protocol. Each network owner has skin in
  // the game (their own users) so they're the right party to tune this.
  mapping(uint32 => mapping(bytes4 => uint128)) public networkGasOverride;

  /// @notice Hard cap on additive gas override per network per selector. Sized
  ///         so the worst-case grief is "cross-chain fees on this network are
  ///         higher" — bounded in dollar terms to fractions of a cent at
  ///         typical L2 gas prices.
  uint128 public constant MAX_GAS_OVERRIDE = 100_000;

  event NetworkCreated(uint32 indexed networkId, CawNetwork network);
  event NetworkFeesLocked(uint32 indexed networkId);
  event NetworkOwnershipLocked(uint32 indexed networkId);
  event NetworkGasOverrideSet(uint32 indexed networkId, bytes4 indexed selector, uint128 newAmount);
  /// @notice Emitted on every per-fee setter (setWithdrawFee/setDepositFee/setAuthFee/
  ///         setMintFee). `feeType` is a stable string label so a single event can carry
  ///         every fee category — cheaper than four separate events for an admin-only
  ///         path that fires rarely. setFeeAddress has its own event (FeeAddressUpdated).
  event NetworkFeeUpdated(uint32 indexed networkId, string feeType, uint256 newFee);
  /// @notice Emitted whenever a network owner ratchets feeCeiling down. The
  ///         ceiling is monotonically non-increasing post-creation, so indexers
  ///         can rely on the latest event being the current ceiling.
  event FeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling);

  // ============================================
  // INSTANCE REGISTRY
  // ============================================
  // Permissionless instance registration. Anyone can register an API+validator
  // instance for any network. Details (apiUrl, validatorAddress) live in events
  // to minimize L1 gas costs. Minimal storage tracks ownership for updates.

  uint32 public nextInstanceId = 1;
  mapping(uint32 => address) public instanceOwner;
  mapping(uint32 => bool) public instanceActive;

  event InstanceRegistered(uint32 indexed instanceId, uint32 indexed networkId, address indexed owner, string apiUrl, address validatorAddress);
  event InstanceUpdated(uint32 indexed instanceId, string apiUrl, address validatorAddress);
  event InstanceDeactivated(uint32 indexed instanceId);
  event InstanceActivated(uint32 indexed instanceId);

  constructor(address _buyAndBurn) {
    buyAndBurnAddress = _buyAndBurn;
  }

  modifier onlyNetworkOwner(uint32 networkId) {
    require(networks[networkId].ownerAddress == msg.sender, "Not the owner");
    _;
  }

  /// @dev Owner check + reverts if the network has locked fee changes.
  modifier onlyNetworkOwnerNotFeeLocked(uint32 networkId) {
    require(networks[networkId].ownerAddress == msg.sender, "Not the owner");
    require(!networkFeesLocked[networkId], "Fees locked");
    _;
  }

  /// @dev Owner check + reverts if the network has locked ownership transfer.
  modifier onlyNetworkOwnerNotOwnershipLocked(uint32 networkId) {
    require(networks[networkId].ownerAddress == msg.sender, "Not the owner");
    require(!networkOwnershipLocked[networkId], "Ownership locked");
    _;
  }

  // ============================================
  // NETWORK MANAGEMENT
  // ============================================

  function getNetwork(uint32 networkId) public view returns (CawNetwork memory) {
    return networks[networkId];
  }

  function getNetworkOwner(uint32 networkId) public view returns (address) {
    return networks[networkId].ownerAddress;
  }

  function getMintFee(uint32 networkId) public view returns (uint256) {
    return networks[networkId].mintFee;
  }

  function getAuthFee(uint32 networkId) public view returns (uint256) {
    return networks[networkId].authFee;
  }

  function getDepositFee(uint32 networkId) public view returns (uint256) {
    return networks[networkId].depositFee;
  }

  function getWithdrawFee(uint32 networkId) public view returns (uint256) {
    return networks[networkId].withdrawFee;
  }

  /// @dev True iff a network has been registered at this id. createNetwork sets
  ///      the struct's `id` to the same nonzero networkId; an unregistered slot
  ///      reads back as the zero struct so id == 0 => not registered.
  function _networkExists(uint32 networkId) internal view returns (bool) {
    return networks[networkId].id != 0;
  }

  function getMintFeeAndAddress(uint32 networkId) public view returns (uint256, address) {
    require(_networkExists(networkId), "Network does not exist");
    CawNetwork storage network = networks[networkId];
    return (network.mintFee, network.feeAddress);
  }

  function getAuthFeeAndAddress(uint32 networkId) public view returns (uint256, address) {
    require(_networkExists(networkId), "Network does not exist");
    CawNetwork storage network = networks[networkId];
    return (network.authFee, network.feeAddress);
  }

  function getDepositFeeAndAddress(uint32 networkId) public view returns (uint256, address) {
    require(_networkExists(networkId), "Network does not exist");
    CawNetwork storage network = networks[networkId];
    return (network.depositFee, network.feeAddress);
  }

  function getWithdrawFeeAndAddress(uint32 networkId) public view returns (uint256, address) {
    require(_networkExists(networkId), "Network does not exist");
    CawNetwork storage network = networks[networkId];
    return (network.withdrawFee, network.feeAddress);
  }

  /**
   * @dev Creates a new CawNetwork with the caller as the owner.
   * @param feeAddress The address to receive fees.
   * @param storageChainEid The L2 chain where this network's actions are processed.
   * @param feeCeiling Upper bound on every individual fee for the lifetime of
   *        the network. Can be lowered later via lowerFeeCeiling(), never raised.
   *        Pass 0 to publicly commit to a permanently-free network (all fees
   *        forced to 0). Each initial fee must be <= feeCeiling.
   */
  function createNetwork(
    string calldata name,
    address feeAddress,
    uint32 storageChainEid,
    uint256 withdrawFee,
    uint256 depositFee,
    uint256 authFee,
    uint256 mintFee,
    uint256 feeCeiling
  ) public {
    require(storageChainEid > 0, "Storage chain required");
    require(bytes(name).length > 0, "Name required");
    require(feeAddress != address(0), "Fee address required");
    require(withdrawFee <= feeCeiling, "withdrawFee exceeds ceiling");
    require(depositFee <= feeCeiling, "depositFee exceeds ceiling");
    require(authFee <= feeCeiling, "authFee exceeds ceiling");
    require(mintFee <= feeCeiling, "mintFee exceeds ceiling");
    networks[nextNetworkId] = CawNetwork({
      id: nextNetworkId,
      storageChainEid: storageChainEid,
      name: name,
      feeAddress: feeAddress,
      ownerAddress: msg.sender,
      withdrawFee: withdrawFee,
      depositFee: depositFee,
      authFee: authFee,
      mintFee: mintFee,
      creationBlock: block.number,
      feeCeiling: feeCeiling
    });

    emit NetworkCreated(nextNetworkId, networks[nextNetworkId]);
    nextNetworkId++;
  }

  /**
   * @dev Changes the owner of a network. Only callable by the current owner.
   * @param networkId The ID of the network.
   * @param newOwner The address of the new owner.
   */
  function changeOwner(uint32 networkId, address newOwner) public onlyNetworkOwnerNotOwnershipLocked(networkId) {
    require(newOwner != address(0), "Zero address");
    networks[networkId].ownerAddress = newOwner;
  }

  /**
  * @dev Sets the withdraw fee for a network. Only callable by the owner.
  * @param networkId The ID of the network.
    * @param fee The new withdraw fee.
      */
  function setWithdrawFee(uint32 networkId, uint256 fee) public onlyNetworkOwnerNotFeeLocked(networkId) {
    require(fee <= networks[networkId].feeCeiling, "exceeds fee ceiling");
    networks[networkId].withdrawFee = fee;
    emit NetworkFeeUpdated(networkId, "withdraw", fee);
  }

  /**
   * @dev Sets the auth fee for a network. Only callable by the owner.
   * @param networkId The ID of the network.
   * @param fee The new auth fee.
   */
  function setAuthFee(uint32 networkId, uint256 fee) public onlyNetworkOwnerNotFeeLocked(networkId) {
    require(fee <= networks[networkId].feeCeiling, "exceeds fee ceiling");
    networks[networkId].authFee = fee;
    emit NetworkFeeUpdated(networkId, "auth", fee);
  }

  /**
   * @dev Sets the deposit fee for a network. Only callable by the owner.
   * @param networkId The ID of the network.
   * @param fee The new deposit fee.
   */
  function setDepositFee(uint32 networkId, uint256 fee) public onlyNetworkOwnerNotFeeLocked(networkId) {
    require(fee <= networks[networkId].feeCeiling, "exceeds fee ceiling");
    networks[networkId].depositFee = fee;
    emit NetworkFeeUpdated(networkId, "deposit", fee);
  }

  function setMintFee(uint32 networkId, uint256 fee) public onlyNetworkOwnerNotFeeLocked(networkId) {
    require(fee <= networks[networkId].feeCeiling, "exceeds fee ceiling");
    networks[networkId].mintFee = fee;
    emit NetworkFeeUpdated(networkId, "mint", fee);
  }

  /**
   * @dev Set all four fees in a single call. Useful for periodic price-pegged adjustments.
   *      Only callable by the network owner.
   * @param networkId The ID of the network.
   * @param withdrawFee New withdraw fee
   * @param depositFee New deposit fee
   * @param authFee New auth fee
   * @param mintFee New mint fee
   */
  function setFees(uint32 networkId, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public onlyNetworkOwnerNotFeeLocked(networkId) {
    CawNetwork storage network = networks[networkId];
    uint256 ceiling = network.feeCeiling;
    require(withdrawFee <= ceiling, "exceeds fee ceiling");
    require(depositFee <= ceiling, "exceeds fee ceiling");
    require(authFee <= ceiling, "exceeds fee ceiling");
    require(mintFee <= ceiling, "exceeds fee ceiling");
    network.withdrawFee = withdrawFee;
    network.depositFee = depositFee;
    network.authFee = authFee;
    network.mintFee = mintFee;
    // One event per category — same shape as the per-fee setters so indexers
    // can treat setFees and setWithdrawFee/setAuthFee/etc. uniformly.
    emit NetworkFeeUpdated(networkId, "withdraw", withdrawFee);
    emit NetworkFeeUpdated(networkId, "deposit", depositFee);
    emit NetworkFeeUpdated(networkId, "auth", authFee);
    emit NetworkFeeUpdated(networkId, "mint", mintFee);
  }

  function setFeeAddress(uint32 networkId, address feeAddress) public onlyNetworkOwnerNotFeeLocked(networkId) {
    // createNetwork enforces non-zero feeAddress; mirror it here so a
    // network owner can't accidentally (or maliciously) zero it out and
    // break payFee accounting (CAW.transfer to address(0) reverts on
    // standard ERC-20s, stranding the network's accrued fees forever).
    // Audit fix 2026-05-08 (CCM-1).
    require(feeAddress != address(0), "Fee address required");
    networks[networkId].feeAddress = feeAddress;
  }

  /**
   * @notice Lower the fee ceiling for a network. Strictly monotonic: the new
   *         ceiling must be **less than** the current ceiling, and must not
   *         drop below any currently-set fee (otherwise existing fees would
   *         become retroactively illegal).
   * @dev Subject to the same owner + fee-lock gate as the per-fee setters,
   *      since making fees harder to raise is a fee-policy change.
   * @param networkId The ID of the network.
   * @param newCeiling The new upper bound on every individual fee.
   */
  function lowerFeeCeiling(uint32 networkId, uint256 newCeiling) public onlyNetworkOwnerNotFeeLocked(networkId) {
    CawNetwork storage network = networks[networkId];
    uint256 oldCeiling = network.feeCeiling;
    require(newCeiling < oldCeiling, "must be lower");
    require(newCeiling >= network.withdrawFee, "below withdrawFee");
    require(newCeiling >= network.depositFee, "below depositFee");
    require(newCeiling >= network.authFee, "below authFee");
    require(newCeiling >= network.mintFee, "below mintFee");
    network.feeCeiling = newCeiling;
    emit FeeCeilingLowered(networkId, oldCeiling, newCeiling);
  }

  function getFeeCeiling(uint32 networkId) public view returns (uint256) {
    return networks[networkId].feeCeiling;
  }

  // ============================================
  // LOCKDOWN
  // ============================================

  /// @notice Permanently freeze fee changes for this network. Cannot be undone.
  /// @dev After this, setWithdrawFee/setAuthFee/setDepositFee/setMintFee/
  ///      setFees/setFeeAddress all revert for this network. The gas override
  ///      remains tunable so the network can still respond to future LZ
  ///      gas miscalibrations.
  function lockNetworkFees(uint32 networkId) external onlyNetworkOwner(networkId) {
    networkFeesLocked[networkId] = true;
    emit NetworkFeesLocked(networkId);
  }

  /// @notice Permanently freeze ownership transfer for this network. Cannot
  ///         be undone. After this, changeOwner reverts for this network and
  ///         the current owner remains the gas-override controller forever.
  function lockNetworkOwnership(uint32 networkId) external onlyNetworkOwner(networkId) {
    networkOwnershipLocked[networkId] = true;
    emit NetworkOwnershipLocked(networkId);
  }

  // ============================================
  // GAS OVERRIDE (ratcheting, capped)
  // ============================================

  /// @notice Bump the additive cross-chain gas budget for a specific selector
  ///         on this network. Strictly ratcheting (newAmount > current) and
  ///         hard-capped at MAX_GAS_OVERRIDE.
  /// @dev Only the network owner can call. Stays callable even after
  ///      lockNetworkFees / lockNetworkOwnership — that's by design, this is
  ///      the recovery hatch the protocol relies on.
  function setGasOverride(uint32 networkId, bytes4 selector, uint128 newAmount)
    external onlyNetworkOwner(networkId)
  {
    require(newAmount > networkGasOverride[networkId][selector], "Must increase");
    require(newAmount <= MAX_GAS_OVERRIDE, "Above cap");
    networkGasOverride[networkId][selector] = newAmount;
    emit NetworkGasOverrideSet(networkId, selector, newAmount);
  }

  function gasOverride(uint32 networkId, bytes4 selector) external view returns (uint128) {
    return networkGasOverride[networkId][selector];
  }

  function getStorageChainEid(uint32 networkId) public view returns (uint32) {
    return networks[networkId].storageChainEid;
  }

  // ============================================
  // INSTANCE MANAGEMENT
  // ============================================
  // Permissionless: anyone can register an instance for any existing network.
  // All instance details (apiUrl, validatorAddress) are stored in events only.

  /**
   * @notice Register a new instance for a network. Permissionless.
   * @param networkId The network this instance serves (must exist)
   * @param apiUrl The public API endpoint URL
   * @param validatorAddress The wallet that submits txns and collects tips
   */
  function registerInstance(uint32 networkId, string calldata apiUrl, address validatorAddress) external returns (uint32) {
    require(networks[networkId].id != 0, "Network does not exist");
    require(bytes(apiUrl).length > 0, "API URL required");
    require(validatorAddress != address(0), "Validator address required");
    uint32 id = nextInstanceId++;
    instanceOwner[id] = msg.sender;
    instanceActive[id] = true;
    emit InstanceRegistered(id, networkId, msg.sender, apiUrl, validatorAddress);
    return id;
  }

  /**
   * @notice Update an instance's details. Only callable by instance owner.
   * @param instanceId The instance to update
   * @param apiUrl The new API endpoint URL
   * @param validatorAddress The new validator wallet address
   */
  function updateInstance(uint32 instanceId, string calldata apiUrl, address validatorAddress) external {
    require(instanceOwner[instanceId] == msg.sender, "Not instance owner");
    require(bytes(apiUrl).length > 0, "API URL required");
    require(validatorAddress != address(0), "Validator address required");
    emit InstanceUpdated(instanceId, apiUrl, validatorAddress);
  }

  /**
   * @notice Deactivate an instance. Only callable by instance owner.
   */
  function deactivateInstance(uint32 instanceId) external {
    require(instanceOwner[instanceId] == msg.sender, "Not instance owner");
    instanceActive[instanceId] = false;
    emit InstanceDeactivated(instanceId);
  }

  /**
   * @notice Reactivate an instance. Only callable by instance owner.
   */
  function activateInstance(uint32 instanceId) external {
    require(instanceOwner[instanceId] == msg.sender, "Not instance owner");
    instanceActive[instanceId] = true;
    emit InstanceActivated(instanceId);
  }
}
