// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct CawClient {
  uint32 id;
  uint32 storageChainEid; // The L2 chain where this client's actions are processed
  string name;
  address feeAddress;
  address ownerAddress;
  uint256 withdrawFee;
  uint256 depositFee;
  uint256 mintFee;
  uint256 authFee;
  // Block at which this client was created, so indexers can scope their
  // historical event scan to [creationBlock, current] instead of scanning
  // the entire contract history. Set once in createClient(); never changes.
  uint256 creationBlock;
}

/**
 * @title CawClientManager
 * @notice Registry of clients and their per-instance API endpoints.
 * @dev Replication destinations used to live here too — pushed to L2 over LayerZero
 *      via CawProfile. That is gone. Per-validator replication targets are now
 *      configuration on the validator (REPLICATE_CLIENT_IDS env), not chain state.
 *      The on-chain part is just identity, fees, owner, storageChainEid, and
 *      instance registry.
 */
contract CawClientManager {

  address public immutable buyAndBurnAddress;

  uint32 public nextClientId = 1;
  mapping(uint32 => CawClient) public clients;

  // Per-client lockdown flags. A client owner can independently freeze fee
  // changes, ownership changes, or both. This lets a client commit to "trust
  // minimized" status (renounce-equivalent) while keeping access to the gas
  // override below — necessary because the protocol has no admin to fix
  // future cross-chain gas miscalibrations.
  mapping(uint32 => bool) public clientFeesLocked;
  mapping(uint32 => bool) public clientOwnershipLocked;

  // Per-client, per-selector additive gas override for cross-chain LZ
  // messages. CawProfile reads this and adds it on top of the hardcoded
  // gasLimitFor baseline. Strictly ratcheting (only goes up), hard-capped
  // at MAX_GAS_OVERRIDE so a compromised client owner can't grief their
  // users with arbitrarily expensive messages.
  //
  // Why per-client (not global): grief surface is bounded to a single
  // client's users, not the whole protocol. Each client owner has skin in
  // the game (their own users) so they're the right party to tune this.
  mapping(uint32 => mapping(bytes4 => uint128)) public clientGasOverride;

  /// @notice Hard cap on additive gas override per client per selector. Sized
  ///         so the worst-case grief is "cross-chain fees on this client are
  ///         higher" — bounded in dollar terms to fractions of a cent at
  ///         typical L2 gas prices.
  uint128 public constant MAX_GAS_OVERRIDE = 100_000;

  event ClientCreated(uint32 indexed clientId, CawClient client);
  event ClientFeesLocked(uint32 indexed clientId);
  event ClientOwnershipLocked(uint32 indexed clientId);
  event ClientGasOverrideSet(uint32 indexed clientId, bytes4 indexed selector, uint128 newAmount);

  // ============================================
  // INSTANCE REGISTRY
  // ============================================
  // Permissionless instance registration. Anyone can register an API+validator
  // instance for any client. Details (apiUrl, validatorAddress) live in events
  // to minimize L1 gas costs. Minimal storage tracks ownership for updates.

  uint32 public nextInstanceId = 1;
  mapping(uint32 => address) public instanceOwner;
  mapping(uint32 => bool) public instanceActive;

  event InstanceRegistered(uint32 indexed instanceId, uint32 indexed clientId, address indexed owner, string apiUrl, address validatorAddress);
  event InstanceUpdated(uint32 indexed instanceId, string apiUrl, address validatorAddress);
  event InstanceDeactivated(uint32 indexed instanceId);
  event InstanceActivated(uint32 indexed instanceId);

  constructor(address _buyAndBurn) {
    buyAndBurnAddress = _buyAndBurn;
  }

  modifier onlyClientOwner(uint32 clientId) {
    require(clients[clientId].ownerAddress == msg.sender, "Not the owner");
    _;
  }

  /// @dev Owner check + reverts if the client has locked fee changes.
  modifier onlyClientOwnerNotFeeLocked(uint32 clientId) {
    require(clients[clientId].ownerAddress == msg.sender, "Not the owner");
    require(!clientFeesLocked[clientId], "Fees locked");
    _;
  }

  /// @dev Owner check + reverts if the client has locked ownership transfer.
  modifier onlyClientOwnerNotOwnershipLocked(uint32 clientId) {
    require(clients[clientId].ownerAddress == msg.sender, "Not the owner");
    require(!clientOwnershipLocked[clientId], "Ownership locked");
    _;
  }

  // ============================================
  // CLIENT MANAGEMENT
  // ============================================

  function getClient(uint32 clientId) public view returns (CawClient memory) {
    return clients[clientId];
  }

  function getClientOwner(uint32 clientId) public view returns (address) {
    return clients[clientId].ownerAddress;
  }

  function getMintFee(uint32 clientId) public view returns (uint256) {
    return clients[clientId].mintFee;
  }

  function getAuthFee(uint32 clientId) public view returns (uint256) {
    return clients[clientId].authFee;
  }

  function getDepositFee(uint32 clientId) public view returns (uint256) {
    return clients[clientId].depositFee;
  }

  function getWithdrawFee(uint32 clientId) public view returns (uint256) {
    return clients[clientId].withdrawFee;
  }

  /// @dev True iff a client has been registered at this id. createClient sets
  ///      the struct's `id` to the same nonzero clientId; an unregistered slot
  ///      reads back as the zero struct so id == 0 => not registered.
  function _clientExists(uint32 clientId) internal view returns (bool) {
    return clients[clientId].id != 0;
  }

  function getMintFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    require(_clientExists(clientId), "Client does not exist");
    CawClient storage client = clients[clientId];
    return (client.mintFee, client.feeAddress);
  }

  function getAuthFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    require(_clientExists(clientId), "Client does not exist");
    CawClient storage client = clients[clientId];
    return (client.authFee, client.feeAddress);
  }

  function getDepositFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    require(_clientExists(clientId), "Client does not exist");
    CawClient storage client = clients[clientId];
    return (client.depositFee, client.feeAddress);
  }

  function getWithdrawFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    require(_clientExists(clientId), "Client does not exist");
    CawClient storage client = clients[clientId];
    return (client.withdrawFee, client.feeAddress);
  }

  /**
   * @dev Creates a new CawClient with the caller as the owner.
   * @param feeAddress The address to receive fees.
   * @param storageChainEid The L2 chain where this client's actions are processed.
   */
  function createClient(string calldata name, address feeAddress, uint32 storageChainEid, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public {
    require(storageChainEid > 0, "Storage chain required");
    require(bytes(name).length > 0, "Name required");
    require(feeAddress != address(0), "Fee address required");
    clients[nextClientId] = CawClient({
      id: nextClientId,
      storageChainEid: storageChainEid,
      name: name,
      feeAddress: feeAddress,
      ownerAddress: msg.sender,
      withdrawFee: withdrawFee,
      depositFee: depositFee,
      authFee: authFee,
      mintFee: mintFee,
      creationBlock: block.number
    });

    emit ClientCreated(nextClientId, clients[nextClientId]);
    nextClientId++;
  }

  /**
   * @dev Changes the owner of a client. Only callable by the current owner.
   * @param clientId The ID of the client.
   * @param newOwner The address of the new owner.
   */
  function changeOwner(uint32 clientId, address newOwner) public onlyClientOwnerNotOwnershipLocked(clientId) {
    require(newOwner != address(0), "Zero address");
    clients[clientId].ownerAddress = newOwner;
  }

  /**
  * @dev Sets the withdraw fee for a client. Only callable by the owner.
  * @param clientId The ID of the client.
    * @param fee The new withdraw fee.
      */
  function setWithdrawFee(uint32 clientId, uint256 fee) public onlyClientOwnerNotFeeLocked(clientId) {
    clients[clientId].withdrawFee = fee;
  }

  /**
   * @dev Sets the auth fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new auth fee.
   */
  function setAuthFee(uint32 clientId, uint256 fee) public onlyClientOwnerNotFeeLocked(clientId) {
    clients[clientId].authFee = fee;
  }

  /**
   * @dev Sets the deposit fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new deposit fee.
   */
  function setDepositFee(uint32 clientId, uint256 fee) public onlyClientOwnerNotFeeLocked(clientId) {
    clients[clientId].depositFee = fee;
  }

  function setMintFee(uint32 clientId, uint256 fee) public onlyClientOwnerNotFeeLocked(clientId) {
    clients[clientId].mintFee = fee;
  }

  /**
   * @dev Set all four fees in a single call. Useful for periodic price-pegged adjustments.
   *      Only callable by the client owner.
   * @param clientId The ID of the client.
   * @param withdrawFee New withdraw fee
   * @param depositFee New deposit fee
   * @param authFee New auth fee
   * @param mintFee New mint fee
   */
  function setFees(uint32 clientId, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public onlyClientOwnerNotFeeLocked(clientId) {
    CawClient storage client = clients[clientId];
    client.withdrawFee = withdrawFee;
    client.depositFee = depositFee;
    client.authFee = authFee;
    client.mintFee = mintFee;
  }

  function setFeeAddress(uint32 clientId, address feeAddress) public onlyClientOwnerNotFeeLocked(clientId) {
    clients[clientId].feeAddress = feeAddress;
  }

  // ============================================
  // LOCKDOWN
  // ============================================

  /// @notice Permanently freeze fee changes for this client. Cannot be undone.
  /// @dev After this, setWithdrawFee/setAuthFee/setDepositFee/setMintFee/
  ///      setFees/setFeeAddress all revert for this client. The gas override
  ///      remains tunable so the client can still respond to future LZ
  ///      gas miscalibrations.
  function lockClientFees(uint32 clientId) external onlyClientOwner(clientId) {
    clientFeesLocked[clientId] = true;
    emit ClientFeesLocked(clientId);
  }

  /// @notice Permanently freeze ownership transfer for this client. Cannot
  ///         be undone. After this, changeOwner reverts for this client and
  ///         the current owner remains the gas-override controller forever.
  function lockClientOwnership(uint32 clientId) external onlyClientOwner(clientId) {
    clientOwnershipLocked[clientId] = true;
    emit ClientOwnershipLocked(clientId);
  }

  // ============================================
  // GAS OVERRIDE (ratcheting, capped)
  // ============================================

  /// @notice Bump the additive cross-chain gas budget for a specific selector
  ///         on this client. Strictly ratcheting (newAmount > current) and
  ///         hard-capped at MAX_GAS_OVERRIDE.
  /// @dev Only the client owner can call. Stays callable even after
  ///      lockClientFees / lockClientOwnership — that's by design, this is
  ///      the recovery hatch the protocol relies on.
  function setGasOverride(uint32 clientId, bytes4 selector, uint128 newAmount)
    external onlyClientOwner(clientId)
  {
    require(newAmount > clientGasOverride[clientId][selector], "Must increase");
    require(newAmount <= MAX_GAS_OVERRIDE, "Above cap");
    clientGasOverride[clientId][selector] = newAmount;
    emit ClientGasOverrideSet(clientId, selector, newAmount);
  }

  function gasOverride(uint32 clientId, bytes4 selector) external view returns (uint128) {
    return clientGasOverride[clientId][selector];
  }

  function getStorageChainEid(uint32 clientId) public view returns (uint32) {
    return clients[clientId].storageChainEid;
  }

  // ============================================
  // INSTANCE MANAGEMENT
  // ============================================
  // Permissionless: anyone can register an instance for any existing client.
  // All instance details (apiUrl, validatorAddress) are stored in events only.

  /**
   * @notice Register a new instance for a client. Permissionless.
   * @param clientId The client this instance serves (must exist)
   * @param apiUrl The public API endpoint URL
   * @param validatorAddress The wallet that submits txns and collects tips
   */
  function registerInstance(uint32 clientId, string calldata apiUrl, address validatorAddress) external returns (uint32) {
    require(clients[clientId].id != 0, "Client does not exist");
    require(bytes(apiUrl).length > 0, "API URL required");
    require(validatorAddress != address(0), "Validator address required");
    uint32 id = nextInstanceId++;
    instanceOwner[id] = msg.sender;
    instanceActive[id] = true;
    emit InstanceRegistered(id, clientId, msg.sender, apiUrl, validatorAddress);
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
