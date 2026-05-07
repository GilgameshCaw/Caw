// contracts/CawProfile.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./CawProfileURI.sol";
import "./CawProfileL2.sol";
import "./CawBuyAndBurn.sol";
import "./OnlyOnce.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawClientManager } from "./CawClientManager.sol";

contract CawProfile is
  Context,
  ERC721Enumerable,
  Ownable,
  OnlyOnce,
  OApp
{
  using OptionsBuilder for bytes;
  using EnumerableSet for EnumerableSet.UintSet;

  IERC20 public immutable CAW;
  CawProfileURI public uriGenerator;

  CawProfileL2 public cawProfileL2;

  uint256 public totalCaw;

  address public minter;

  uint32 public mainnetLzId;
  string[] public usernames;
  bool private fromLZ;

  /// @notice Selector for L2's mint mirror. Currently unused — mint() does not lzSend.
  /// @dev Reserved for a future "mint + authenticate (no deposit)" flow that pushes
  ///      username + owner to L2 at mint time so the token can receive internal CAW
  ///      transfers from other tokens before its own first deposit. Keeping the selector,
  ///      gasLimitFor branch, and L2 receiver wired now means we don't need to redeploy
  ///      to enable that flow later — these contracts are immutable post-deployment.
  bytes4 public mintSelector = bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])"));

  bytes4 public addToBalanceSelector = bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])"));
  bytes4 public authSelector = bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])"));
  bytes4 public updateOwnersSelector = bytes4(keccak256("updateOwners(uint32[],address[])"));
  /// @notice Selector for the mint+auth (no deposit) flow. Brings the L2 mirror in line
  ///         with the L1 NFT in one LZ message: sets username, owner, and the auth flag.
  bytes4 public mintAuthSelector = bytes4(keccak256("mintAuthAndUpdateOwners(uint32,uint32,address,string,uint32[],address[])"));

  /// @notice Selector for the bundled deposit + register-session L2 handler. Used by the
  ///         mintAndDepositAndQuickSign flow so a fresh user mints+deposits+auths+quicksigns
  ///         in a single L1 transaction. The L2 receiver hard-wires scopeBitmap = 0xBF —
  ///         WITHDRAW is permanently non-delegatable.
  bytes4 public depositRegisterSessionSelector = bytes4(keccak256("depositAndRegisterSessionAndUpdateOwners(uint32,uint32,uint256,address,address,uint64,uint256,uint64,uint32[],address[])"));

  /// @notice Selector for the bundled mint+auth + register-session L2 handler. Used by the
  ///         mintAndAuthAndQuickSign flow (no deposit). Same 0xBF scope hard-wire on L2.
  bytes4 public mintAuthRegisterSessionSelector = bytes4(keccak256("mintAuthAndRegisterSessionAndUpdateOwners(uint32,uint32,address,string,address,uint64,uint256,uint64,uint32[],address[])"));

  /// @dev Per-selector base gas limit (the constant component; per-update overhead is added
  ///      separately in `gasLimitFor`). Initialized in the constructor. An unset selector
  ///      returns 0, which causes the L2 receive to OOG and revert downstream — a meaningful
  ///      revert path. Internal visibility saves the auto-getter bytecode (the Quoter doesn't
  ///      need to read it directly; it calls lzQuote which calls gasLimitFor).
  mapping(bytes4 => uint128) internal gasBaseFor;

  // Keeping track of clients to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  /// @notice Withdraw fee locked in at the moment a token first authenticates with a client.
  /// @dev Once set, this fee floor is honored forever — clients cannot retroactively raise
  ///      withdraw fees on existing depositors. On withdraw, the user pays min(locked, current),
  ///      so they automatically benefit if the client lowers fees later. Indexed by (clientId, tokenId).
  mapping(uint32 => mapping(uint32 => uint256)) public lockedWithdrawFee;
  /// @notice True once a token has had its withdraw fee locked for a client. Used to distinguish
  ///         "locked at zero" from "never locked" (since 0 is a valid fee).
  mapping(uint32 => mapping(uint32 => bool)) public withdrawFeeLocked;

  mapping(uint32 => uint256) public withdrawable;

  uint256 public rewardMultiplier = 10**18;

  // tokenId => [lzDestId, lzDestId2, ...]
  mapping(uint32 => EnumerableSet.UintSet) private chosenChainIds;
  EnumerableSet.UintSet peerIds;

  // lzDestId => index => tokenId
  mapping(uint32 => mapping(uint256 => uint32)) public pendingTransfers;
  uint256 public transferUpdateLimit = 50;

  // lzDestId => value
  mapping(uint32 => uint256) internal pendingTransferStart;
  mapping(uint32 => uint256) internal pendingTransferEnd;

  struct Token {
    uint256 withdrawable;
    uint256 ownerBalance;
    uint256 tokenId;
    string username;
    address owner;
  }

  event MinterSet(address minter);
  event TransferPendingSync(uint32 indexed tokenId, address indexed from, address indexed to);
  event L2PeerSet(uint32 indexed eid, address indexed peer);
  event Deposited(uint32 indexed cawClientId, uint32 indexed tokenId, uint256 amount, uint32 indexed lzDestId, address depositor);
  // NOTE: no L1-side `Withdrawn` event. The CAW token's ERC20 Transfer
  // (cawProfile → recipient) inside `withdrawTo` is already observable
  // and uniquely identifies withdrawals — we can spend the contract-size
  // budget on more useful events. The L2 side has its own `Withdrawn`
  // for the totalCaw decrement, which has no equivalent observable.

  CawClientManager public clientManager;
  CawBuyAndBurn public buyAndBurn;

  constructor(address _caw, address _gui, address _buyAndBurn, address _clientManager, address _endpoint, uint32 mainnetEid)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {
    clientManager = CawClientManager(payable(_clientManager));
    uriGenerator = CawProfileURI(_gui);
    buyAndBurn = CawBuyAndBurn(payable(_buyAndBurn));
    CAW = IERC20(_caw);
    mainnetLzId = mainnetEid;

    // Per-selector base gas budgets. authSelector bumped from 50k → 85k after a
    // production OOG (Tenderly tx 0x3b8a0232... on Base Sepolia). Bundled session
    // selectors add ~80k to their non-bundled counterpart for the StoredSession
    // SSTORE (3 cold fields ~66k) + SessionCreated event (~3k).
    gasBaseFor[addToBalanceSelector]            = 110_000;
    gasBaseFor[mintSelector]                    =  75_000;
    gasBaseFor[updateOwnersSelector]            =  25_000;
    gasBaseFor[authSelector]                    =  85_000;
    gasBaseFor[mintAuthSelector]                = 125_000;
    gasBaseFor[depositRegisterSessionSelector]  = 190_000;
    gasBaseFor[mintAuthRegisterSessionSelector] = 205_000;
  }

  function setL2Peer(uint32 _eid, address _peer)
    external
    onlyOwner
    onlyOnce(keccak256(abi.encode("setL2Peer", _eid)))
  {
    require(_peer != address(0), "Zero address");
    if (_eid != mainnetLzId) {
      peerIds.add(uint256(_eid));
      setPeer(_eid, bytes32(uint256(uint160(_peer))));
    } else cawProfileL2 = CawProfileL2(_peer);
    emit L2PeerSet(_eid, _peer);
  }

  /// @notice Lock the inherited OApp `setPeer` once per eid. Critical: a compromised
  /// or rogue owner could otherwise swap a peer to a contract they control and start
  /// delivering forged LZ messages. Once a peer for an eid is set (typically in deploy
  /// phase 1), it can NEVER be changed — even by the owner. Adding NEW eids (new chains)
  /// stays open by design.
  ///
  /// Note: other Ownable-gated inherited setters (setDelegate on OAppCore,
  /// transferOwnership on Ownable) are not overridden here — they're handled by the
  /// pre-mainnet checklist (multisig handoff or renounce).
  function setPeer(uint32 _eid, bytes32 _peer)
    public
    override
    onlyOnce(keccak256(abi.encode("setPeer", _eid)))
  {
    super.setPeer(_eid, _peer);
  }

  /// @dev SECURITY NOTE — setDelegate hardening: the inherited setDelegate
  ///      is non-virtual; rely on owner renouncement post-deploy. See
  ///      CawActionsArchive.sol for full reasoning.

  function setMinter(address _minter)
    external
    onlyOwner
    onlyOnce(keccak256("setMinter"))
  {
    require(_minter != address(0), "Zero address");
    minter = _minter;
    emit MinterSet(_minter);
  }

  function setUriGenerator(address _gui)
    external
    onlyOwner
    onlyOnce(keccak256("setUriGenerator"))
  {
    require(_gui != address(0), "Zero address");
    uriGenerator = CawProfileURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint32(tokenId) - 1]);
  }

  function mint(uint32 cawClientId, address owner, string memory username, uint32 newId, uint256 lzTokenAmount) public payable {
    require(minter == _msgSender(), "Not minter");
    usernames.push(username);
    _mint(owner, newId);

    (uint256 fee, address feeAddress) = clientManager.getMintFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  /// @notice Mint a username and authenticate it with a client in one transaction,
  ///         WITHOUT depositing any CAW. The L2 mirror is brought in line via LZ
  ///         (or a direct call in co-deployment mode) so the token has its username,
  ///         owner, and auth flag on L2 from the start. Posts will revert until the
  ///         user does a separate deposit to fund their cawBalance.
  ///
  /// @dev Optionally bundles a Quick Sign session registration in the same LZ message
  ///      when `sessionExtra.length > 0`. Pass empty bytes for the original behavior.
  ///      Encoding: abi.encode(address sessionKey, uint64 expiry, uint256 spendLimit).
  ///
  /// @dev SECURITY NOTE — trust chain for the bundled session leg (audit 2026-04-28):
  ///      Only the Minter (set once via setMinter) can call this. The Minter's bundled
  ///      wrapper `mintAndAuthAndQuickSign` is **self-mint only**: it always sets
  ///      `recipient = msg.sender` before calling here, so `owner` is the EOA that paid
  ///      gas. There is NO `*For` variant of the bundled flow — a third party cannot
  ///      inject a session into someone else's wallet via this entry point. The L2
  ///      receiver writes `sessions[owner][sessionKey]` with scopeBitmap hard-wired to
  ///      0xBF (WITHDRAW permanently non-delegatable). `expiry > block.timestamp` is
  ///      enforced on the L2 side.
  function mintAndAuth(
    uint32 cawClientId, address owner, string memory username, uint32 newId,
    uint32 lzDestId, uint256 lzTokenAmount, bytes calldata sessionExtra
  ) public payable {
    require(minter == _msgSender(), "Not minter");
    usernames.push(username);
    _mint(owner, newId);

    uint256 totalFeesPaid = 0;
    {
      (uint256 mintFee, address mintFeeAddr) = clientManager.getMintFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(mintFee, mintFeeAddr);

      (uint256 authFee, address authFeeAddr) = clientManager.getAuthFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
    }

    authenticated[cawClientId][newId] = true;
    _lockWithdrawFeeIfNeeded(cawClientId, newId);
    chosenChainIds[newId].add(uint256(lzDestId));
    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.mintAndAuth(newId, owner, username, cawClientId);
      if (sessionExtra.length > 0) {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        cawProfileL2.registerSessionFromL1(owner, sk, ex, sl, tr);
      }
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, owner, newId);
      bytes4 sel;
      bytes memory payload;
      if (sessionExtra.length == 0) {
        sel = mintAuthSelector;
        payload = abi.encodeWithSelector(sel, cawClientId, newId, owner, username, tokenIds, owners);
      } else {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        sel = mintAuthRegisterSessionSelector;
        payload = abi.encodeWithSelector(sel, cawClientId, newId, owner, username, sk, ex, sl, tr, tokenIds, owners);
      }
      lzSend(cawClientId, lzDestId, sel, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  /// @notice Mint a username and deposit CAW in one transaction.
  ///
  /// @dev Optionally bundles a Quick Sign session registration in the same LZ message
  ///      when `sessionExtra.length > 0`. Pass empty bytes for the original behavior.
  ///      Encoding: abi.encode(address sessionKey, uint64 expiry, uint256 spendLimit).
  ///
  /// @dev SECURITY NOTE — trust chain for the bundled session leg (audit 2026-04-28):
  ///      Only the Minter (set once via setMinter) can call this. The Minter's bundled
  ///      wrapper `mintAndDepositAndQuickSign` is **self-mint only**: it always sets
  ///      `recipient = msg.sender` before calling here, so `owner` is the EOA that paid
  ///      gas. There is NO `*For` variant of the bundled flow — a third party cannot
  ///      inject a session into someone else's wallet via this entry point. The L2
  ///      receiver writes `sessions[owner][sessionKey]` with scopeBitmap hard-wired to
  ///      0xBF (WITHDRAW permanently non-delegatable). `expiry > block.timestamp` is
  ///      enforced on the L2 side.
  function mintAndDeposit(
    uint32 cawClientId, address owner, string memory username, uint32 newId,
    uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount, bytes calldata sessionExtra
  ) public payable {
    require(minter == _msgSender(), "Not minter");
    usernames.push(username);
    _mint(owner, newId);

    CAW.transferFrom(_msgSender(), address(this), depositAmount);
    totalCaw += depositAmount;
    chosenChainIds[newId].add(uint256(lzDestId));

    uint256 totalFeesPaid = 0;
    {
      (uint256 mintFee, address mintFeeAddr) = clientManager.getMintFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(mintFee, mintFeeAddr);

      (uint256 depositFee, address depositFeeAddr) = clientManager.getDepositFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(depositFee, depositFeeAddr);

      (uint256 authFee, address authFeeAddr) = clientManager.getAuthFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
    }

    authenticated[cawClientId][newId] = true;
    _lockWithdrawFeeIfNeeded(cawClientId, newId);
    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.deposit(cawClientId, newId, depositAmount);
      if (sessionExtra.length > 0) {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        cawProfileL2.registerSessionFromL1(owner, sk, ex, sl, tr);
      }
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, owner, newId);
      bytes4 sel;
      bytes memory payload;
      if (sessionExtra.length == 0) {
        sel = addToBalanceSelector;
        payload = abi.encodeWithSelector(sel, cawClientId, newId, depositAmount, tokenIds, owners);
      } else {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        sel = depositRegisterSessionSelector;
        payload = abi.encodeWithSelector(sel, cawClientId, newId, depositAmount, owner, sk, ex, sl, tr, tokenIds, owners);
      }
      lzSend(cawClientId, lzDestId, sel, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }

    // Emit Deposited so indexers can reconstruct totalCaw inflows symmetrically with
    // the standalone `depositFor` path. Without this, every onboarding deposit (every
    // wallet that mints + deposits in one tx) is invisible to the L1 watcher and the
    // activity ledger, causing totalCaw on chain to drift above sum-of-recorded-deposits.
    emit Deposited(cawClientId, newId, depositAmount, lzDestId, _msgSender());
  }

  /// @notice Accrued fees available for withdrawal (pull pattern to prevent DOS)
  mapping(address => uint256) public accruedFees;

  event FeesAccrued(address indexed recipient, uint256 amount);
  event FeesWithdrawn(address indexed recipient, uint256 amount);

  /// @dev Lock the withdraw fee for a (client, token) pair the first time they authenticate.
  ///      Subsequent calls are no-ops, ensuring users always get their first-deposit terms or better.
  function _lockWithdrawFeeIfNeeded(uint32 cawClientId, uint32 tokenId) internal {
    if (!withdrawFeeLocked[cawClientId][tokenId]) {
      lockedWithdrawFee[cawClientId][tokenId] = clientManager.getWithdrawFee(cawClientId);
      withdrawFeeLocked[cawClientId][tokenId] = true;
    }
  }

  function payFee(uint256 fee, address feeAddress) internal returns (uint256) {
    if (fee > 0) {
      accruedFees[feeAddress] += fee;
      accruedFees[address(buyAndBurn)] += fee;
      emit FeesAccrued(feeAddress, fee);
      emit FeesAccrued(address(buyAndBurn), fee);
    }
    return fee * 2;
  }

  /// @dev Refund any unused LZ ETH back to the caller. Called from the
  ///      bypassLZ / no-pending-queue branches that don't actually send
  ///      a LayerZero message; without this the over-paid `lzEthAmount`
  ///      sits in the contract permanently (no sweep path). Audit fix
  ///      2026-05-08 (L1 M-1).
  function _refundUnusedLzEth(uint256 amount) internal {
    if (amount == 0) return;
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok, "Refund failed");
  }

  /// @notice Withdraw accrued fees as CAW. Swaps the client's ETH fees + the matching protocol
  ///         portion together into CAW via Uniswap. Client receives half the CAW, other half is burned.
  /// @param minCawOut Minimum total CAW the swap must produce (sandwich protection).
  ///                  Client receives minCawOut/2, protocol burns minCawOut/2.
  ///                  Use buyAndBurn.getExpectedCawOut(totalETH) and apply slippage (e.g. 97%).
  /// @dev By paying the client in CAW from the same swap, their incentives are perfectly aligned
  ///      with the protocol: a bad minCawOut hurts the client's own payout equally. A client
  ///      calling withdrawFees(0) would get sandwiched and lose their own fees — self-punishing.
  function withdrawFees(uint256 minCawOut) external {
    _withdrawFees(msg.sender, minCawOut);
  }

  /// @notice Withdraw fees on behalf of a client. Callable by the client's owner.
  ///         CAW is sent to the client's feeAddress (not the caller).
  /// @param clientId The client whose fees to withdraw.
  /// @param minCawOut Minimum total CAW the swap must produce (sandwich protection).
  function withdrawFeesFor(uint32 clientId, uint256 minCawOut) external {
    require(clientManager.getClientOwner(clientId) == msg.sender, "Not client owner");
    address feeAddress = clientManager.getClient(clientId).feeAddress;
    _withdrawFees(feeAddress, minCawOut);
  }

  function _withdrawFees(address feeAddress, uint256 minCawOut) internal {
    uint256 clientAmount = accruedFees[feeAddress];
    require(clientAmount > 0, "No fees");

    uint256 protocolPool = accruedFees[address(buyAndBurn)];
    uint256 protocolAmount = clientAmount < protocolPool ? clientAmount : protocolPool;

    // Zero balances before external calls (checks-effects-interactions)
    accruedFees[feeAddress] = 0;
    if (protocolAmount > 0) {
      accruedFees[address(buyAndBurn)] -= protocolAmount;
    }

    uint256 totalEth = clientAmount + protocolAmount;
    uint256 cawReceived = buyAndBurn.swapAndSplit{value: totalEth}(minCawOut, feeAddress);

    emit FeesWithdrawn(feeAddress, cawReceived);
  }

  function nextId() public view returns (uint32) {
    return uint32(usernames.length) + 1;
  }

  // `tokens(address)` and `token(uint32)` convenience views were removed to
  // claw back ~250 bytes of bytecode and keep CawProfile under the EIP-170
  // deployable cap. The same data is available via the standard ERC-721
  // enumerable interface (balanceOf + tokenOfOwnerByIndex) plus the `usernames`,
  // `withdrawable`, and `CAW.balanceOf` getters; off-chain consumers can
  // multiplex those, or read it from CawProfileQuoter, or add a new sibling
  // helper view contract later.

  /**
  * @dev See {IERC165-supportsInterface}.
  */
  function supportsInterface(bytes4 interfaceId)
    public
    view
    virtual
    override(ERC721Enumerable)
    returns (bool)
  {
    return super.supportsInterface(interfaceId);
  }

  function authenticate(uint32 cawClientId, uint32 tokenId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(ownerOf(tokenId) == msg.sender, "Not owner");

    (uint256 fee, address feeAddress) = clientManager.getAuthFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);
    authenticated[cawClientId][tokenId] = true;
    _lockWithdrawFeeIfNeeded(cawClientId, tokenId);

    // Subscribe this token to lzDestId so future _afterTokenTransfer
    // pushes the new owner there. Without this, a token authenticated to
    // chain X via this function (rather than mintAndAuth/mintAndDeposit
    // which DO subscribe) would never receive ownership-sync messages on
    // chain X after a future transfer — the previous owner could keep
    // posting as the username on chain X indefinitely. Audit fix
    // 2026-05-08 (H-1, CawProfile-agent finding).
    chosenChainIds[tokenId].add(uint256(lzDestId));

    if (lzDestId == mainnetLzId) {
      cawProfileL2.auth(tokenId, cawClientId);
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, msg.sender, tokenId);
      bytes memory payload = abi.encodeWithSelector(authSelector, cawClientId, tokenId, tokenIds, owners);
      lzSend(cawClientId, lzDestId, authSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  /// @notice Deposit CAW into a token on behalf of its owner. CAW is pulled from msg.sender
  ///         (not the token owner), so the caller must have approved this contract for CAW.
  ///         This allows router contracts to collect CAW from the user and deposit in one flow.
  function depositFor(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    address owner = ownerOf(tokenId);

    // depositFor is intentionally permissionless (routers pay-on-behalf-of),
    // but a zero-amount call lets a third party permanently mark a token
    // as subscribed to chains the owner never opted into, plus auth them
    // to clients they didn't pick. Require a non-zero deposit so the caller
    // at least has economic skin in the game. Audit fix 2026-05-08 (M-2).
    require(amount > 0, "Zero deposit amount");

    chosenChainIds[tokenId].add(uint256(lzDestId));
    CAW.transferFrom(msg.sender, address(this), amount);
    totalCaw += amount;

    (uint256 fee, address feeAddress) = clientManager.getDepositFeeAndAddress(cawClientId);

    if (!authenticated[cawClientId][tokenId]) {
      fee += clientManager.getAuthFee(cawClientId);
      authenticated[cawClientId][tokenId] = true;
      _lockWithdrawFeeIfNeeded(cawClientId, tokenId);
    }

    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    if (lzDestId == mainnetLzId) {
      cawProfileL2.deposit(cawClientId, tokenId, amount);
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, owner, tokenId);
      bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, cawClientId, tokenId, amount, tokenIds, owners);
      lzSend(cawClientId, lzDestId, addToBalanceSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }

    emit Deposited(cawClientId, tokenId, amount, lzDestId, msg.sender);
  }

  function deposit(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "Not owner");
    depositFor(cawClientId, tokenId, amount, lzDestId, lzTokenAmount);
  }

  function peerWithMaxPendingTransfers() public view returns (uint32) {
    // Empty peerIds set — no L2 peers configured (single-chain mainnet
    // co-deploy). EnumerableSet.at(0) panics on empty set, which would
    // brick mint() / withdrawTo() / transferAndSync() since they all
    // call _updateNewOwners(peerWithMaxPendingTransfers(), ...). Return
    // sentinel 0 and treat it as "nothing to flush" downstream.
    // Audit fix 2026-05-08 (M-3, CawProfile-agent finding).
    if (peerIds.length() == 0) return 0;

    uint256 updatesNeeded;
    uint256 peer = peerIds.at(0);
    uint256 max = updatesNeededForPeer(uint32(peer));

    for (uint256 i = 1; i < peerIds.length(); i++) {
      updatesNeeded = updatesNeededForPeer(uint32(peerIds.at(i)));
      if (updatesNeeded > max) {
        max = updatesNeeded;
        peer = peerIds.at(i);
      }
    }

    return uint32(peer);
  }

  function withdraw(uint32 cawClientId, uint32 tokenId, uint256 lzTokenAmount) public payable {
    withdrawTo(cawClientId, tokenId, msg.sender, lzTokenAmount);
  }

  /// @notice Withdraw CAW to any address. Only callable by the token owner.
  function withdrawTo(uint32 cawClientId, uint32 tokenId, address recipient, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "Not owner");
    require(withdrawable[tokenId] > 0, "Nothing to withdraw");
    require(recipient != address(0), "Zero address");

    uint256 amount = withdrawable[tokenId];
    totalCaw -= withdrawable[tokenId];
    withdrawable[tokenId] = 0;

    (uint256 currentFee, address feeAddress) = clientManager.getWithdrawFeeAndAddress(cawClientId);
    uint256 fee = currentFee;
    if (withdrawFeeLocked[cawClientId][tokenId]) {
      uint256 locked = lockedWithdrawFee[cawClientId][tokenId];
      if (locked < fee) fee = locked;
    }
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    CAW.transfer(recipient, amount);
    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
    // Withdraw is observable via the ERC20 Transfer fired by CAW.transfer
    // above (from = address(this), to = recipient). No bespoke event
    // needed — see event-declarations comment near `Deposited`.
  }

  /**
   * @notice Transfer a token and immediately sync ownership to L2 via LayerZero.
   * @dev Requires msg.value to cover the LZ fee. Use syncTransferQuote() on CawProfileQuoter to estimate.
   *      Also flushes any other pending ownership transfers for the target chain.
   * @param to The recipient address
   * @param tokenId The token to transfer
   * @param lzTokenAmount LZ token amount for fees (usually 0)
   */
  function transferAndSync(address to, uint256 tokenId, uint256 lzTokenAmount) external payable {
    address owner = ownerOf(tokenId);
    require(
      owner == msg.sender ||
      isApprovedForAll(owner, msg.sender) ||
      getApproved(tokenId) == msg.sender,
      "caller is not owner or approved"
    );
    _transfer(owner, to, tokenId);
    // _afterTokenTransfer queued this token — now flush the queue via LZ
    _updateNewOwners(peerWithMaxPendingTransfers(), msg.value, lzTokenAmount);
  }

  /**
   * @notice Manually sync pending ownership transfers to L2.
   * @dev Anyone can call this (typically the new owner after a marketplace transfer).
   *      Flushes all pending transfers for the chain with the most pending updates.
   * @param lzTokenAmount LZ token amount for fees (usually 0)
   */
  function syncTransfer(uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(updatesNeededForPeer(lzDestId) > 0, "No pending");
    _updateNewOwners(lzDestId, msg.value, lzTokenAmount);
  }

  // ============================================
  // REPLICATION CONFIG SYNC
  // ============================================

  // Replication-chain sync to L2 has been removed. Per-validator REPLICATE_CLIENT_IDS
  // env config replaced the on-chain registry; no L1→L2 chain-list push is needed.

  /// @notice Credit per-token withdraw amounts. Only callable via LayerZero from L2 CawProfileL2.
  /// @dev SECURITY NOTE (audited 2026-04-07): No `tokenIds.length == amounts.length` check is
  ///      intentional. The only caller is `CawActions.setWithdrawable` (on L2), which constructs
  ///      both arrays from the same `withdrawCount` variable in lockstep — they are guaranteed
  ///      to have equal length by construction. Adding a length check here would burn L1 gas
  ///      (paid by the validator via LZ fees) on every withdraw batch for a check that cannot
  ///      fail. Both contracts are immutable post-deployment, so the construction invariant
  ///      cannot be broken by future code changes.
  function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts) external {
    // Two acceptable callers:
    //   1. The LZ delivery path (fromLZ flag set inside _lzReceive)
    //   2. The bypassLZ co-deployed L2 mirror calling directly. Without
    //      this branch, withdrawals on L1-storage (bypassLZ) clients
    //      silently lose CAW: L2's setWithdrawable bypassLZ branch calls
    //      this function directly, but a fromLZ-only gate would always
    //      revert and the WITHDRAW action's L2 debit (which already
    //      happened in CawActions._applyAction.withdrawTokens) would
    //      have no L1 counterpart. Audit fix 2026-05-08 (C-1).
    require(
      fromLZ || msg.sender == address(cawProfileL2),
      "Only LZ or co-deployed L2 mirror"
    );
    for (uint256 i = 0; i < tokenIds.length; i++)
      withdrawable[tokenIds[i]] += amounts[i];
  }

  function getChosenChainIdAtIndex(uint32 token, uint256 index) public view returns (uint256) {
    return chosenChainIds[token].at(index);
  }

  function _afterTokenTransfer(address from, address to, uint256 tokenId, uint256 batchSize) internal virtual override {
    uint32 token = uint32(tokenId);
    EnumerableSet.UintSet storage chainIds = chosenChainIds[token];
    bool hasPendingSync = false;
    for (uint256 i = 0; i < chainIds.length(); i++) {
      uint32 chainId = uint32(chainIds.at(i));
      if (chainId == mainnetLzId) cawProfileL2.setOwnerOf(token, to);
      else {
        pendingTransfers[chainId][pendingTransferEnd[chainId]++] = token;
        hasPendingSync = true;
      }
    }
    // Emit event so backend can freeze economic actions until L2 syncs
    if (hasPendingSync && from != address(0)) {
      emit TransferPendingSync(token, from, to);
    }
  }

  function updatesNeededForPeer(uint32 lzDestId) public view returns (uint256) {
    return Math.min(transferUpdateLimit, pendingTransferEnd[lzDestId] - pendingTransferStart[lzDestId]);
  }

  function pendingTransferUpdates(uint32 lzDestId) public view returns (uint32[] memory, address[] memory) {
    return pendingTransferUpdates(lzDestId, address(0), 0);
  }

  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) public view returns (uint32[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId] + i];
      owners[i] = ownerOf(tokenIds[i]);
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
    }

    return (tokenIds, owners);
  }

  function extractPendingTransferUpdates(uint32 lzDestId) internal returns (uint32[] memory, address[] memory) {
    return extractPendingTransferUpdates(lzDestId, address(0), 0);
  }

  function extractPendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) internal returns (uint32[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      delete pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      owners[i] = ownerOf(tokenIds[i]);
      pendingTransferStart[lzDestId]++;
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
    }

    return (tokenIds, owners);
  }

  /// @dev updateOwners messages sync the entire pending-transfer queue across all
  ///      tokens regardless of which client they're authed to, so the gas budget
  ///      reads `clientGasOverride[0][updateOwnersSelector]` — clientId=0 is
  ///      reserved for protocol-wide overrides. CawClientManager.setGasOverride
  ///      can't write clientId=0 (no owner), so this slot stays at 0 forever
  ///      unless a future amendment adds a controlled path. Acceptable: the
  ///      updateOwners handler is the lowest-risk one in the system.
  function _updateNewOwners(uint32 lzDestId, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    // Sentinel 0 from peerWithMaxPendingTransfers means "no peers
    // configured" — nothing to flush. See M-3 fix above.
    if (lzDestId == 0) return;

    uint32[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates(lzDestId);
    if (tokenIds.length > 0) {
      if (lzDestId == mainnetLzId)
        cawProfileL2.updateOwners(tokenIds, owners);
      else {
        bytes memory payload = abi.encodeWithSelector(updateOwnersSelector, tokenIds, owners);
        lzSend(0, lzDestId, updateOwnersSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
      }
    }
  }

  function _lzReceive(
    Origin calldata _origin, // struct containing info about the message sender
    bytes32 _guid, // global packet identifier
    bytes calldata payload, // encoded message payload being received
    address _executor, // the Executor address.
    bytes calldata // arbitrary data appended by the Executor
  ) internal override {
    // Declare selector and arguments as memory variables
    bytes4 decodedSelector;
    bytes memory args = new bytes(payload.length - 4); // Arguments excluding the first 4 bytes

    assembly {
      // Copy the selector (first 4 bytes) from calldata
      decodedSelector := calldataload(payload.offset)

      // Copy the arguments from calldata to memory
      calldatacopy(add(args, 32), add(payload.offset, 4), sub(payload.length, 4))
    }

    // Ensure the selector corresponds to an expected function to prevent unauthorized actions
    require(isAuthorizedFunction(decodedSelector), "Unauthorized");

    // Call the function using the selector and arguments.
    //
    // SECURITY NOTE (audited 2026-04-06): The fromLZ + delegatecall pattern is intentional and safe.
    // - The OApp base class already verifies msg.sender == endpoint and the peer before _lzReceive runs.
    // - The only authorized function (setWithdrawable) makes zero external calls — no reentrancy vector.
    // - fromLZ cannot get stuck: on success it resets below; on revert the entire tx rolls back.
    // - The endpoint is immutable (set once in constructor, can never change).
    // - These contracts are immutable post-deployment, so no new authorized functions can be added.
    // - An alternative like msg.sender == endpoint would not work here because the authorized functions
    //   are public (required for delegatecall dispatch), and fromLZ is needed to distinguish the
    //   _lzReceive call path from direct external calls.
    fromLZ = true;
    (bool success, bytes memory returnData) = address(this).delegatecall(bytes.concat(decodedSelector, args));
    fromLZ = false;

    // Handle failure and revert with the error message
    if (!success) {
      // If the returndata is empty, use a generic error message
      if (returnData.length == 0) {
        revert("Delegatecall failed");
      } else {
        // Bubble up the revert reason
        assembly {
          let returndata_size := mload(returnData)
          revert(add(32, returnData), returndata_size)
        }
      }
    }
  }

  // Whitelist of selectors allowed via delegatecall from LayerZero messages.
  // Security: verified that no authorized selector collides with any inherited
  // function from OApp, ERC721, ERC721Enumerable, or Ownable.
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));
  }

  // Overriding this internal function because inherited LZ code requires msg.value == _nativeFee,
  // which doesn't allow for clients to take native fees alongside LZ.
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256 nativeFee) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return _nativeFee;
  }

  function lzSend(uint32 cawClientId, uint32 lzDestId, bytes4 selector, uint256 n, bytes memory payload, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(cawClientId, selector, n), 0);

    // Refund excess LZ fee to tx.origin — the EOA that actually paid.
    // Using msg.sender would break when called through an intermediary contract
    // (e.g. CawProfileMarketplace.acceptOffer -> transferAndSync) because the contract
    // wouldn't have a receive() function to accept the refund.
    _lzSend(
      lzDestId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(lzEthAmount, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(tx.origin) // Refund excess LZ fee to the tx originator (the EOA paying)
    );
  }


  // Most quote functions moved to CawProfileQuoter contract to reduce contract size
  // lzQuote stays here since it needs access to inherited _quote from OApp

  function lzQuote(uint32 cawClientId, bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(cawClientId, selector, n), 0);
    return _quote(lzDestId, payload, _options, _payInLzToken);
  }

  /// @notice Gas limit forwarded to the destination chain for executing this message.
  /// @dev Sized as base + per-entry * n, where n is the array length in the payload.
  ///      Numbers are derived from real measurements (scripts/measure-gas.js) plus a safety
  ///      margin sized to cover cold-slot SSTOREs + the LZ V2 reentrancy-sentry tail.
  ///
  ///      `authSelector` baseline was bumped from 50k → 85k after a production OOG
  ///      (Tenderly tx 0x3b8a0232... on Base Sepolia). The other selectors are left at
  ///      their original measured baselines because they have not shown undersizing
  ///      in production.
  ///
  ///      `clientGasOverride` from CawClientManager is added on top — see that contract
  ///      for the per-client ratchet that lets a client owner bump this budget if some
  ///      future EVM/L2/LZ change ever undersizes a path. Cap'd at MAX_GAS_OVERRIDE so
  ///      a compromised client owner can't grief their own users with arbitrary fees.
  function gasLimitFor(uint32 cawClientId, bytes4 selector, uint256 n) public view returns (uint128) {
    // Unset selectors return 0 here; the LZ send downstream will OOG meaningfully on the
    // L2 receive call (gas budget far below any handler's needs), so a bad selector still
    // reverts — just without an explicit require message in this hot path.
    return gasBaseFor[selector] + uint128(19_000 * n) + clientManager.clientGasOverride(cawClientId, selector);
  }

  receive() external payable {}
  fallback() external payable {}

}

