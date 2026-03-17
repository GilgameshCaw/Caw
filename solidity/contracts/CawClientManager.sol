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
}

/// @notice Replication destination: chain ID + contract address
struct ReplicationDestination {
  address target;  // Contract address on that chain (e.g., CawActionsArchive)
  uint32 eid;      // LayerZero endpoint ID
}

/// @notice Messaging fee struct from LayerZero
struct MessagingFee {
  uint256 nativeFee;
  uint256 lzTokenFee;
}

/// @notice Interface for CawName's replication sync functions
interface ICawName {
  function syncReplicationInternal(uint32 clientId, uint32[] calldata destEids, uint32 lzDestId) external payable;
  function syncReplicationQuote(uint32 clientId, uint32[] calldata destEids, uint32 lzDestId, bool payInLzToken) external view returns (MessagingFee memory);
}

/**
 * @title CawClientManager
 * @notice Manages client configuration including fees and replication destinations.
 * @dev Deployed on L1. This is a simple registry - cross-chain messaging is handled by CawName.
 *      Replication config changes are automatically synced to L2 via CawName's LayerZero connection.
 */
contract CawClientManager {

  address public immutable buyAndBurnAddress;

  /// @notice The CawName contract used for L1->L2 sync
  ICawName public cawName;

  uint32 public nextClientId = 1;
  mapping(uint32 => CawClient) public clients;

  /// @notice Replication destinations configured for each client
  /// @dev Maximum 4 replication destinations per client
  mapping(uint32 => ReplicationDestination[]) public clientReplications;

  /// @notice Whether replication is enabled for a client
  mapping(uint32 => bool) public clientReplicationEnabled;

  event ClientCreated(uint32 indexed clientId, CawClient client);
  event ClientReplicationAdded(uint32 indexed clientId, uint32 indexed eid, address target);
  event ClientReplicationRemoved(uint32 indexed clientId, uint32 indexed eid);
  event ClientReplicationEnabledChanged(uint32 indexed clientId, bool enabled);

  address public owner;

  modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
  }

  constructor(address _buyAndBurn) {
    buyAndBurnAddress = _buyAndBurn;
    owner = msg.sender;
  }

  /**
   * @notice Set the CawName contract address. Can only be called once.
   * @param _cawName The CawName contract address
   */
  function setCawName(address _cawName) external onlyOwner {
    require(address(cawName) == address(0), "CawName already set");
    cawName = ICawName(_cawName);
  }

  /**
   * @notice Renounce ownership after setup is complete
   */
  function renounceOwnership() external onlyOwner {
    owner = address(0);
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

  function setFeeAddress(uint32 clientId, address feeAddress) public onlyClientOwner(clientId) {
    clients[clientId].feeAddress = feeAddress;
  }

  // ============================================
  // REPLICATION CONFIG MANAGEMENT
  // ============================================
  // Note: These functions only update local state. The CawName contract
  // is responsible for syncing changes to L2 via LayerZero.

  /**
   * @notice Add a replication destination for a client.
   * @dev Automatically syncs to L2 via CawName. Requires msg.value for LayerZero fees.
   *      Target address is managed by the replicator owner via addArchiveChain, not by the client.
   * @param clientId The ID of the client.
   * @param eid The LayerZero endpoint ID of the destination chain.
   */
  function addReplication(uint32 clientId, uint32 eid) public payable onlyClientOwner(clientId) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    require(replications.length < 4, "Maximum 4 replication destinations");

    // Check if already exists
    for (uint i = 0; i < replications.length; i++)
      require(replications[i].eid != eid, "Replication chain already added");

    replications.push(ReplicationDestination({
      target: address(0), // Target managed by replicator owner
      eid: eid
    }));

    clientReplicationEnabled[clientId] = true;

    emit ClientReplicationAdded(clientId, eid, address(0));

    // Auto-sync full chain list to client's storage chain
    if (address(cawName) != address(0)) {
      uint32 storageEid = clients[clientId].storageChainEid;
      cawName.syncReplicationInternal{value: msg.value}(clientId, getClientChainEids(clientId), storageEid);
    }
  }

  /**
   * @notice Remove a replication destination from a client.
   * @dev Automatically syncs updated chain list to L2 via CawName. Requires msg.value for LayerZero fees.
   * @param clientId The ID of the client.
   * @param eid The LayerZero endpoint ID to remove.
   */
  function removeReplication(uint32 clientId, uint32 eid) public payable onlyClientOwner(clientId) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    for (uint i = 0; i < replications.length; i++) {
      if (replications[i].eid == eid) {
        replications[i] = replications[replications.length - 1];
        replications.pop();

        emit ClientReplicationRemoved(clientId, eid);

        // Auto-sync updated chain list to client's storage chain
        if (address(cawName) != address(0)) {
          uint32 storageEid = clients[clientId].storageChainEid;
          cawName.syncReplicationInternal{value: msg.value}(clientId, getClientChainEids(clientId), storageEid);
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

  /**
   * @notice Get all replication destinations for a client.
   */
  function getReplications(uint32 clientId) public view returns (ReplicationDestination[] memory) {
    if (!clientReplicationEnabled[clientId])
      return new ReplicationDestination[](0);
    return clientReplications[clientId];
  }

  /**
   * @notice Get the number of replication destinations for a client.
   */
  function getReplicationCount(uint32 clientId) public view returns (uint256) {
    if (!clientReplicationEnabled[clientId]) return 0;
    return clientReplications[clientId].length;
  }

  /**
   * @notice Get all chain EIDs for a client's replication destinations.
   * @param clientId The client ID
   * @return eids Array of destination endpoint IDs
   */
  function getClientChainEids(uint32 clientId) public view returns (uint32[] memory) {
    ReplicationDestination[] storage replications = clientReplications[clientId];
    uint32[] memory eids = new uint32[](replications.length);
    for (uint i = 0; i < replications.length; i++) {
      eids[i] = replications[i].eid;
    }
    return eids;
  }

  /**
   * @notice Get a quote for the LayerZero fee to sync replication config.
   * @param clientId The client ID
   * @return quote The MessagingFee with nativeFee and lzTokenFee
   */
  function replicationSyncQuote(uint32 clientId) public view returns (MessagingFee memory) {
    require(address(cawName) != address(0), "CawName not set");
    uint32 storageEid = clients[clientId].storageChainEid;
    return cawName.syncReplicationQuote(clientId, getClientChainEids(clientId), storageEid, false);
  }

  function getStorageChainEid(uint32 clientId) public view returns (uint32) {
    return clients[clientId].storageChainEid;
  }
}
