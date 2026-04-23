// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OnlyOnce.sol";

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
}

/// @notice Replication destination: chain ID + contract address
struct ReplicationDestination {
  address target;  // Contract address on that chain (e.g., CawActionsArchive)
  uint32 eid;      // LayerZero endpoint ID
}

/// @notice Interface for CawProfile's cross-chain sync functions.
/// @dev Quote functions live on CawProfileQuoter — call them directly from off-chain.
interface ICawProfile {
  function syncReplicationInternal(uint32 clientId, uint32[] calldata destEids, uint32 lzDestId) external payable;
}

/**
 * @title CawClientManager
 * @notice Manages client configuration including fees and replication destinations.
 * @dev Deployed on L1. This is a simple registry - cross-chain messaging is handled by CawProfile.
 *      Replication config changes are automatically synced to L2 via CawProfile's LayerZero connection.
 */
contract CawClientManager is Ownable, OnlyOnce {

  address public immutable buyAndBurnAddress;

  /// @notice The CawProfile contract used for L1->L2 sync
  ICawProfile public cawProfile;

  uint32 public nextClientId = 1;
  mapping(uint32 => CawClient) public clients;

  /// @notice Replication destinations configured for each client.
  /// @dev Maximum 8 replication destinations per client.
  mapping(uint32 => ReplicationDestination[]) public clientReplications;

  /// @notice Whether replication is enabled for a client
  mapping(uint32 => bool) public clientReplicationEnabled;

  event ClientCreated(uint32 indexed clientId, CawClient client);
  event ClientReplicationAdded(uint32 indexed clientId, uint32 indexed eid, address target);
  event ClientReplicationRemoved(uint32 indexed clientId, uint32 indexed eid);
  event ClientReplicationEnabledChanged(uint32 indexed clientId, bool enabled);
  event CawProfileSet(address indexed cawProfile);

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

  /**
   * @notice Set the CawProfile contract address. Owner-only, one-shot.
   * @param _cawProfile The CawProfile contract address
   */
  function setCawProfile(address _cawProfile)
    external
    onlyOwner
    onlyOnce(keccak256("setCawProfile"))
  {
    require(_cawProfile != address(0), "Zero address");
    cawProfile = ICawProfile(_cawProfile);
    emit CawProfileSet(_cawProfile);
  }

  modifier onlyClientOwner(uint32 clientId) {
    require(clients[clientId].ownerAddress == msg.sender, "Not the owner");
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

  function getMintFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.mintFee, client.feeAddress);
  }

  function getAuthFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.authFee, client.feeAddress);
  }

  function getDepositFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.depositFee, client.feeAddress);
  }

  function getWithdrawFeeAndAddress(uint32 clientId) public view returns (uint256, address) {
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
      mintFee: mintFee
    });

    emit ClientCreated(nextClientId, clients[nextClientId]);
    nextClientId++;
  }

  /**
   * @dev Changes the owner of a client. Only callable by the current owner.
   * @param clientId The ID of the client.
   * @param newOwner The address of the new owner.
   */
  function changeOwner(uint32 clientId, address newOwner) public onlyClientOwner(clientId) {
    require(newOwner != address(0), "Zero address");
    clients[clientId].ownerAddress = newOwner;
  }

  /**
  * @dev Sets the withdraw fee for a client. Only callable by the owner.
  * @param clientId The ID of the client.
    * @param fee The new withdraw fee.
      */
  function setWithdrawFee(uint32 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].withdrawFee = fee;
  }

  /**
   * @dev Sets the auth fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new auth fee.
   */
  function setAuthFee(uint32 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].authFee = fee;
  }

  /**
   * @dev Sets the deposit fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new deposit fee.
   */
  function setDepositFee(uint32 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].depositFee = fee;
  }

  function setMintFee(uint32 clientId, uint256 fee) public onlyClientOwner(clientId) {
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
  function setFees(uint32 clientId, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public onlyClientOwner(clientId) {
    CawClient storage client = clients[clientId];
    client.withdrawFee = withdrawFee;
    client.depositFee = depositFee;
    client.authFee = authFee;
    client.mintFee = mintFee;
  }

  function setFeeAddress(uint32 clientId, address feeAddress) public onlyClientOwner(clientId) {
    clients[clientId].feeAddress = feeAddress;
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

  // ============================================
  // REPLICATION CONFIG MANAGEMENT
  // ============================================
  // Note: These functions only update local state. The CawProfile contract
  // is responsible for syncing changes to L2 via LayerZero.

  /**
   * @notice Add a replication destination for a client.
   * @dev Records the destination chain on L1 and syncs the updated chain list to
   *      L2 via CawProfile's LayerZero peer; CawProfileL2 then emits ClientChainsSet
   *      for indexers. Requires msg.value for LayerZero fees.
   * @param clientId The ID of the client.
   * @param eid The LayerZero endpoint ID of the destination chain.
   */
  /// @param clientId  The ID of the client.
  /// @param eid       LZ endpoint ID of the destination chain.
  function addReplication(uint32 clientId, uint32 eid) public payable onlyClientOwner(clientId) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    require(replications.length < 8, "Maximum 8 replication destinations");

    for (uint i = 0; i < replications.length; i++)
      require(replications[i].eid != eid, "Replication chain already added");

    replications.push(ReplicationDestination({ target: address(0), eid: eid }));
    clientReplicationEnabled[clientId] = true;
    emit ClientReplicationAdded(clientId, eid, address(0));

    if (address(cawProfile) != address(0)) {
      uint32 storageEid = clients[clientId].storageChainEid;
      cawProfile.syncReplicationInternal{value: msg.value}(clientId, getClientChainEids(clientId), storageEid);
    }
  }

  /**
   * @notice Remove a replication destination from a client.
   * @dev Automatically syncs updated chain list to L2 via CawProfile. Requires msg.value for LayerZero fees.
   */
  function removeReplication(uint32 clientId, uint32 eid) public payable onlyClientOwner(clientId) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    for (uint i = 0; i < replications.length; i++) {
      if (replications[i].eid == eid) {
        replications[i] = replications[replications.length - 1];
        replications.pop();

        emit ClientReplicationRemoved(clientId, eid);

        if (address(cawProfile) != address(0)) {
          uint32 storageEid = clients[clientId].storageChainEid;
          cawProfile.syncReplicationInternal{value: msg.value}(clientId, getClientChainEids(clientId), storageEid);
        }
        return;
      }
    }
    revert("Replication destination not found");
  }

  /**
   * @notice Enable or disable replication for a client.
   */
  function setReplicationEnabled(uint32 clientId, bool enabled) public onlyClientOwner(clientId) {
    clientReplicationEnabled[clientId] = enabled;
    emit ClientReplicationEnabledChanged(clientId, enabled);
  }

  /// @notice Get all replication destinations for a client.
  function getReplications(uint32 clientId) public view returns (ReplicationDestination[] memory) {
    if (!clientReplicationEnabled[clientId]) return new ReplicationDestination[](0);
    return clientReplications[clientId];
  }

  /// @notice Get the number of replication destinations for a client.
  function getReplicationCount(uint32 clientId) public view returns (uint256) {
    if (!clientReplicationEnabled[clientId]) return 0;
    return clientReplications[clientId].length;
  }

  /// @notice Get all chain EIDs for a client's replication destinations.
  function getClientChainEids(uint32 clientId) public view returns (uint32[] memory) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    uint32[] memory eids = new uint32[](replications.length);
    for (uint i = 0; i < replications.length; i++) {
      eids[i] = replications[i].eid;
    }
    return eids;
  }

  function getStorageChainEid(uint32 clientId) public view returns (uint32) {
    return clients[clientId].storageChainEid;
  }

  /// @notice Accept ETH refunds from LayerZero. When `addReplication`/`removeReplication` forwards
  /// `msg.value` to `CawProfile.syncReplicationInternal`, the LZ refund address ends up being this
  /// contract (since CawProfile uses `payable(msg.sender)` for refunds, and msg.sender at the LZ
  /// boundary is this contract). Without `receive()`, the LZ excess-fee refund would revert the
  /// entire add/remove flow.
  receive() external payable {}
}
