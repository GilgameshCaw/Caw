pragma solidity ^0.8.0;

struct CawClient {
  uint64 id;
  address feeAddress;
  address ownerAddress;
  uint256 withdrawFee;
  uint256 depositFee;
  uint256 mintFee;
  uint256 authFee;
}

contract CawClientManager {

  address buyAndBurnAddress;
  uint64 public nextClientId = 1;
  mapping(uint64 => CawClient) public clients;

  event ClientCreated(uint64 nextClientId, CawClient client);

  constructor(address _buyAndBurn) {
    buyAndBurnAddress = _buyAndBurn;
  }

  modifier onlyClientOwner(uint64 clientId) {
    require(clients[clientId].ownerAddress == msg.sender, "Not the owner");
    _;
  }

  /**
   * @dev Returns the client data for a given ID.
   * @param clientId The ID of the client.
   * @return The CawClient struct.
   */
  function getClient(uint64 clientId) public view returns (CawClient memory) {
    return clients[clientId];
  }

  function getMintFee(uint64 clientId) public view returns (uint256) {
    CawClient storage client = clients[clientId];
    return client.mintFee;
  }

  function getAuthFee(uint64 clientId) public view returns (uint256) {
    CawClient storage client = clients[clientId];
    return client.authFee;
  }

  function getDepositFee(uint64 clientId) public view returns (uint256) {
    CawClient storage client = clients[clientId];
    return client.depositFee;
  }

  function getWithdrawFee(uint64 clientId) public view returns (uint256) {
    CawClient storage client = clients[clientId];
    return client.withdrawFee;
  }

  function getMintFeeAndAddress(uint64 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.mintFee, client.feeAddress);
  }

  function getAuthFeeAndAddress(uint64 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.authFee, client.feeAddress);
  }

  function getDepositFeeAndAddress(uint64 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.depositFee, client.feeAddress);
  }

  function getWithdrawFeeAndAddress(uint64 clientId) public view returns (uint256, address) {
    CawClient storage client = clients[clientId];
    return (client.withdrawFee, client.feeAddress);
  }

  /**
   * @dev Creates a new CawClient with the caller as the owner.
   * @param feeAddress The address to receive fees.
   */
  function createClient(address feeAddress, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public {
    clients[nextClientId] = CawClient({
      id: nextClientId,
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
  function changeOwner(uint64 clientId, address newOwner) public onlyClientOwner(clientId) {
    clients[clientId].ownerAddress = newOwner;
  }

  /**
  * @dev Sets the withdraw fee for a client. Only callable by the owner.
  * @param clientId The ID of the client.
    * @param fee The new withdraw fee.
      */
  function setWithdrawFee(uint64 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].withdrawFee = fee;
  }

  /**
   * @dev Sets the auth fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new auth fee.
   */
  function setAuthFee(uint64 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].authFee = fee;
  }

  /**
   * @dev Sets the deposit fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new deposit fee.
   */
  function setDepositFee(uint64 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].depositFee = fee;
  }

  /**
   * @dev Sets the mint fee for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param fee The new mint fee.
   */
  function setMintFee(uint64 clientId, uint256 fee) public onlyClientOwner(clientId) {
    clients[clientId].mintFee = fee;
  }

  /**
   * @dev Sets the fee address for a client. Only callable by the owner.
   * @param clientId The ID of the client.
   * @param feeAddress The new fee address.
   */
  function setFeeAddress(uint64 clientId, address feeAddress) public onlyClientOwner(clientId) {
    clients[clientId].feeAddress = feeAddress;
  }
}


