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
import "./CawL1PriceReader.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawNetworkManager } from "./CawNetworkManager.sol";

contract CawProfile is
  Context,
  ERC721Enumerable,
  Ownable,
  OnlyOnce,
  OApp
{
  // Custom errors — bytecode-cheaper than `require(cond, "msg")` because the
  // selector is 4 bytes vs the variable-length string. Needed on 0.8.30 where
  // codegen grew the deployed bytecode close enough to the EIP-170 24,576-byte
  // cap that the string form pushed CawProfile over.
  error ZeroAddr();
  error NotMinter();
  error NotOwner();
  error RefundFailed();
  error NotNetOwner();
  error NoFees();
  error ZeroDeposit();
  error NothingToWithdraw();
  error NoPending();
  error Unauthorized();
  error DelegateFailed();
  error NotApproved();
  error NotL2Mirror();
  error TooManyChains();

  using OptionsBuilder for bytes;
  using EnumerableSet for EnumerableSet.UintSet;

  IERC20 public immutable CAW;
  CawProfileURI public uriGenerator;

  /// @notice L1 price reader for piggybacking cumulative price onto L1→L2 messages.
  ///         May be address(0) if no oracle is configured (cap dormant on L2).
  CawL1PriceReader public immutable priceReader;

  CawProfileL2 public cawProfileL2;

  uint256 public totalCaw;

  address public minter;

  uint32 public mainnetLzId;
  string[] public usernames;
  bool private fromLZ;

  // Precomputed L2 handler selectors. Stored as internal state (no public getter
  // bytecode overhead); explicit view wrappers below satisfy CawProfileQuoter.
  // ALL selectors that carry an ownership-update tail include a uint64[]
  // stamps parameter as the final array. L1 stamps each (tokenId, owner)
  // entry with block.number at flush time. L2 honors the highest stamp
  // seen per tokenId — funds piggybacked on the same message ALWAYS
  // apply, but a stale ownership write is silently skipped so L2
  // converges to L1's source-of-truth ordering. L2 also bumps a
  // per-owner sessionEpoch on every transfer-out, invalidating any
  // session keys that wallet had registered before the bump (closes
  // the Bob-briefly-held-token attack from CL-4). Audit fix 2026-05-11
  // (Round 7 CL-4).
  bytes4 internal constant _mintSelector                    = bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[],uint64[])"));
  bytes4 internal constant _addToBalanceSelector            = bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[],uint64[])"));
  bytes4 internal constant _authSelector                    = bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[],uint64[])"));
  bytes4 internal constant _updateOwnersSelector            = bytes4(keccak256("updateOwners(uint32[],address[],uint64[])"));
  bytes4 internal constant _mintAuthSelector                = bytes4(keccak256("mintAuthAndUpdateOwners(uint32,uint32,address,string,uint32[],address[],uint64[])"));
  bytes4 internal constant _depositRegisterSessionSelector  = bytes4(keccak256("depositAndRegisterSessionAndUpdateOwners(uint32,uint32,uint256,address,address,uint64,uint256,uint64,uint32[],address[],uint64[])"));
  bytes4 internal constant _mintAuthRegisterSessionSelector = bytes4(keccak256("mintAuthAndRegisterSessionAndUpdateOwners(uint32,uint32,address,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])"));
  bytes4 internal constant _allowFreeAuthSelector           = bytes4(keccak256("setAllowFreeAuth(uint32,bool)"));

  /// @dev Per-selector base gas limit (the constant component; per-update overhead is added
  ///      separately in `gasLimitFor`). Initialized in the constructor. An unset selector
  ///      returns 0, which causes the L2 receive to OOG and revert downstream — a meaningful
  ///      revert path. Internal visibility saves the auto-getter bytecode (the Quoter doesn't
  ///      need to read it directly; it calls lzQuote which calls gasLimitFor).
  mapping(bytes4 => uint128) internal gasBaseFor;

  // Keeping track of networks to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  /// @notice Withdraw fee locked in at the moment a token first authenticates with a network.
  /// @dev Once set, this fee floor is honored forever — networks cannot retroactively raise
  ///      withdraw fees on existing depositors. On withdraw, the user pays min(locked, current),
  ///      so they automatically benefit if the network lowers fees later. Indexed by (networkId, tokenId).
  mapping(uint32 => mapping(uint32 => uint256)) public lockedWithdrawFee;
  /// @notice True once a token has had its withdraw fee locked for a network. Used to distinguish
  ///         "locked at zero" from "never locked" (since 0 is a valid fee).
  mapping(uint32 => mapping(uint32 => bool)) public withdrawFeeLocked;

  mapping(uint32 => uint256) public withdrawable;

  uint256 public constant rewardMultiplier = 10**18;

  // tokenId => [lzDestId, lzDestId2, ...]
  mapping(uint32 => EnumerableSet.UintSet) private chosenChainIds;
  EnumerableSet.UintSet peerIds;

  // lzDestId => index => tokenId
  mapping(uint32 => mapping(uint256 => uint32)) public pendingTransfers;
  uint256 public constant transferUpdateLimit = 50;
  uint256 public constant MAX_CHOSEN_CHAINS = 128;

  // lzDestId => value
  mapping(uint32 => uint256) internal pendingTransferStart;
  mapping(uint32 => uint256) internal pendingTransferEnd;

  event MinterSet(address minter);
  event TransferPendingSync(uint32 indexed tokenId, address indexed from, address indexed to);
  event L2PeerSet(uint32 indexed eid, address indexed peer);
  event Deposited(uint32 indexed cawNetworkId, uint32 indexed tokenId, uint256 amount, uint32 indexed lzDestId, address depositor);
  // NOTE: no L1-side `Withdrawn` event. The CAW token's ERC20 Transfer
  // (cawProfile → recipient) inside `withdrawTo` is already observable
  // and uniquely identifies withdrawals — we can spend the contract-size
  // budget on more useful events. The L2 side has its own `Withdrawn`
  // for the totalCaw decrement, which has no equivalent observable.

  CawNetworkManager public networkManager;
  CawBuyAndBurn public buyAndBurn;

  constructor(address _caw, address _gui, address _buyAndBurn, address _networkManager, address _endpoint, uint32 mainnetEid, address _priceReader)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {
    networkManager = CawNetworkManager(payable(_networkManager));
    uriGenerator = CawProfileURI(_gui);
    buyAndBurn = CawBuyAndBurn(payable(_buyAndBurn));
    CAW = IERC20(_caw);
    mainnetLzId = mainnetEid;
    priceReader = CawL1PriceReader(_priceReader); // address(0) = no oracle

    // Per-selector base gas budgets. authSelector bumped from 50k → 85k after a
    // production OOG (Tenderly tx 0x3b8a0232... on Base Sepolia). Bundled session
    // selectors add ~80k to their non-bundled counterpart for the StoredSession
    // SSTORE (3 cold fields ~66k) + SessionCreated event (~3k).
    // CL-4 fix bumped each L2 handler by ~20-30k for the per-tokenId stamp
    // SSTORE + epoch SLOAD + StoredSession.epoch SSTORE on session-bundling
    // selectors. Per-token cost in `gasLimitFor` separately covers the new
    // stamp slot per ownership update.
    gasBaseFor[_addToBalanceSelector]            = 150_000;
    gasBaseFor[_mintSelector]                    = 100_000;
    gasBaseFor[_updateOwnersSelector]            =  40_000;
    gasBaseFor[_authSelector]                    = 110_000;
    gasBaseFor[_mintAuthSelector]                = 155_000;
    gasBaseFor[_depositRegisterSessionSelector]  = 225_000;
    gasBaseFor[_mintAuthRegisterSessionSelector] = 240_000;
    // setAllowFreeAuth: one SSTORE (5k cold → 2.1k warm) + minimal ABI decode.
    // Budget 35k to cover cold storage + dispatcher overhead + LZ executor tail.
    gasBaseFor[_allowFreeAuthSelector]           =  35_000;
  }

  function setL2Peer(uint32 _eid, address _peer)
    external
    onlyOwner
    onlyOnce(keccak256(abi.encode("setL2Peer", _eid)))
  {
    if (_peer == address(0)) revert ZeroAddr();
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
    if (_minter == address(0)) revert ZeroAddr();
    minter = _minter;
    emit MinterSet(_minter);
  }

  function setUriGenerator(address _gui)
    external
    onlyOwner
    onlyOnce(keccak256("setUriGenerator"))
  {
    if (_gui == address(0)) revert ZeroAddr();
    uriGenerator = CawProfileURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint32(tokenId) - 1]);
  }

  function mint(uint32 cawNetworkId, address owner, string memory username, uint32 newId, uint256 lzTokenAmount) public payable {
    if (minter != _msgSender()) revert NotMinter();
    usernames.push(username);
    _mint(owner, newId);

    (uint256 fee, address feeAddress) = networkManager.getMintFeeAndAddress(cawNetworkId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  /// @notice Mint a username and authenticate it with a network in one transaction,
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
    uint32 cawNetworkId, address owner, string memory username, uint32 newId,
    uint32 lzDestId, uint256 lzTokenAmount, bytes calldata sessionExtra
  ) public payable {
    if (minter != _msgSender()) revert NotMinter();
    usernames.push(username);
    _mint(owner, newId);

    uint256 totalFeesPaid = 0;
    {
      (uint256 mintFee, address mintFeeAddr) = networkManager.getMintFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(mintFee, mintFeeAddr);

      (uint256 authFee, address authFeeAddr) = networkManager.getAuthFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
    }

    authenticated[cawNetworkId][newId] = true;
    _lockWithdrawFeeIfNeeded(cawNetworkId, newId);
    _addChosenChain(newId, lzDestId);
    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.mintAndAuth(newId, owner, username, cawNetworkId, uint64(block.number));
      if (sessionExtra.length > 0) {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        cawProfileL2.registerSessionFromL1(owner, sk, ex, sl, tr);
      }
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      uint64[] memory stamps;
      (tokenIds, owners, stamps) = extractPendingTransferUpdates(lzDestId, owner, newId);
      bytes4 sel;
      bytes memory payload;
      if (sessionExtra.length == 0) {
        sel = _mintAuthSelector;
        payload = abi.encodeWithSelector(sel, cawNetworkId, newId, owner, username, tokenIds, owners, stamps);
      } else {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        sel = _mintAuthRegisterSessionSelector;
        payload = abi.encodeWithSelector(sel, cawNetworkId, newId, owner, username, sk, ex, sl, tr, tokenIds, owners, stamps);
      }
      lzSend(cawNetworkId, lzDestId, sel, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
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
    uint32 cawNetworkId, address owner, string memory username, uint32 newId,
    uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount, bytes calldata sessionExtra
  ) public payable {
    if (minter != _msgSender()) revert NotMinter();
    usernames.push(username);
    _mint(owner, newId);

    CAW.transferFrom(_msgSender(), address(this), depositAmount);
    totalCaw += depositAmount;
    _addChosenChain(newId, lzDestId);

    uint256 totalFeesPaid = 0;
    {
      (uint256 mintFee, address mintFeeAddr) = networkManager.getMintFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(mintFee, mintFeeAddr);

      (uint256 depositFee, address depositFeeAddr) = networkManager.getDepositFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(depositFee, depositFeeAddr);

      (uint256 authFee, address authFeeAddr) = networkManager.getAuthFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
    }

    authenticated[cawNetworkId][newId] = true;
    _lockWithdrawFeeIfNeeded(cawNetworkId, newId);
    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.deposit(cawNetworkId, newId, depositAmount);
      if (sessionExtra.length > 0) {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        cawProfileL2.registerSessionFromL1(owner, sk, ex, sl, tr);
      }
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      uint64[] memory stamps;
      (tokenIds, owners, stamps) = extractPendingTransferUpdates(lzDestId, owner, newId);
      bytes4 sel;
      bytes memory payload;
      if (sessionExtra.length == 0) {
        sel = _addToBalanceSelector;
        payload = abi.encodeWithSelector(sel, cawNetworkId, newId, depositAmount, tokenIds, owners, stamps);
      } else {
        (address sk, uint64 ex, uint256 sl, uint64 tr) = abi.decode(sessionExtra, (address, uint64, uint256, uint64));
        sel = _depositRegisterSessionSelector;
        payload = abi.encodeWithSelector(sel, cawNetworkId, newId, depositAmount, owner, sk, ex, sl, tr, tokenIds, owners, stamps);
      }
      lzSend(cawNetworkId, lzDestId, sel, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }

    // Emit Deposited so indexers can reconstruct totalCaw inflows symmetrically with
    // the standalone `depositFor` path. Without this, every onboarding deposit (every
    // wallet that mints + deposits in one tx) is invisible to the L1 watcher and the
    // activity ledger, causing totalCaw on chain to drift above sum-of-recorded-deposits.
    emit Deposited(cawNetworkId, newId, depositAmount, lzDestId, _msgSender());
  }

  /// @notice Accrued fees available for withdrawal (pull pattern to prevent DOS)
  mapping(address => uint256) public accruedFees;

  event FeesAccrued(address indexed recipient, uint256 amount);
  event FeesWithdrawn(address indexed recipient, uint256 amount);

  /// @dev Lock the withdraw fee for a (network, token) pair the first time they authenticate.
  ///      Subsequent calls are no-ops, ensuring users always get their first-deposit terms or better.
  function _lockWithdrawFeeIfNeeded(uint32 cawNetworkId, uint32 tokenId) internal {
    if (!withdrawFeeLocked[cawNetworkId][tokenId]) {
      lockedWithdrawFee[cawNetworkId][tokenId] = networkManager.getWithdrawFee(cawNetworkId);
      withdrawFeeLocked[cawNetworkId][tokenId] = true;
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
    if (!(ok)) revert RefundFailed();
  }

  /// @notice Withdraw accrued fees as CAW. Swaps the network's ETH fees + the matching protocol
  ///         portion together into CAW via Uniswap. Network receives half the CAW, other half is burned.
  /// @param minCawOut Minimum total CAW the swap must produce (sandwich protection).
  ///                  Network receives minCawOut/2, protocol burns minCawOut/2.
  ///                  Use buyAndBurn.getExpectedCawOut(totalETH) and apply slippage (e.g. 97%).
  /// @dev By paying the network in CAW from the same swap, their incentives are perfectly aligned
  ///      with the protocol: a bad minCawOut hurts the network's own payout equally. A network
  ///      calling withdrawFees(0) would get sandwiched and lose their own fees — self-punishing.
  function withdrawFees(uint256 minCawOut) external {
    _withdrawFees(msg.sender, minCawOut);
  }

  /// @notice Withdraw fees on behalf of a network. Callable by the network's owner.
  ///         CAW is sent to the network's feeAddress (not the caller).
  /// @param networkId The network whose fees to withdraw.
  /// @param minCawOut Minimum total CAW the swap must produce (sandwich protection).
  function withdrawFeesFor(uint32 networkId, uint256 minCawOut) external {
    if (networkManager.getNetworkOwner(networkId) != msg.sender) revert NotNetOwner();
    address feeAddress = networkManager.getNetwork(networkId).feeAddress;
    _withdrawFees(feeAddress, minCawOut);
  }

  function _withdrawFees(address feeAddress, uint256 minCawOut) internal {
    uint256 networkAmount = accruedFees[feeAddress];
    if (networkAmount == 0) revert NoFees();

    uint256 protocolPool = accruedFees[address(buyAndBurn)];
    uint256 protocolAmount = networkAmount < protocolPool ? networkAmount : protocolPool;

    // Zero balances before external calls (checks-effects-interactions)
    accruedFees[feeAddress] = 0;
    if (protocolAmount > 0) {
      accruedFees[address(buyAndBurn)] -= protocolAmount;
    }

    uint256 totalEth = networkAmount + protocolAmount;
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

  function authenticate(uint32 cawNetworkId, uint32 tokenId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    if (ownerOf(tokenId) != msg.sender) revert NotOwner();
    _authenticateBody(cawNetworkId, tokenId, lzDestId, msg.sender, lzTokenAmount);
  }

  /// @notice Authenticate a token to a network on behalf of its owner.
  ///         Callable only by the minter contract. Used by the sponsored auth
  ///         path (CawProfileMinter.authenticateSponsored) so a relayer can pay
  ///         the LZ fee without the token owner needing ETH.
  /// @param owner The current token owner — used as the new-owner hint in the
  ///              pending-transfer update bundle sent to the destination chain.
  function authenticateForMinter(uint32 cawNetworkId, uint32 tokenId, uint32 lzDestId, address owner, uint256 lzTokenAmount) external payable {
    if (msg.sender != minter) revert NotMinter();
    // Defense-in-depth: the Minter is the only caller (gated above) and the
    // current Minter design resolves `owner` via `ownerOf(tokenId)` immediately
    // before this call — so the supplied `owner` should always match the chain
    // state. Re-check here so a future Minter-side bug (or v2 Minter that
    // accepts caller-supplied owner) can't silently inject a fake new-owner
    // hint into the LZ payload. Final audit 2026-05-21 L-1.
    if (ownerOf(tokenId) != owner) revert NotOwner();
    _authenticateBody(cawNetworkId, tokenId, lzDestId, owner, lzTokenAmount);
  }

  /// @dev Shared body for authenticate and authenticateForMinter. Caller
  ///      must validate access before delegating here.
  function _authenticateBody(uint32 cawNetworkId, uint32 tokenId, uint32 lzDestId, address owner, uint256 lzTokenAmount) private {
    (uint256 fee, address feeAddress) = networkManager.getAuthFeeAndAddress(cawNetworkId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);
    authenticated[cawNetworkId][tokenId] = true;
    _lockWithdrawFeeIfNeeded(cawNetworkId, tokenId);

    // Subscribe this token to lzDestId so future _afterTokenTransfer
    // pushes the new owner there. Without this, a token authenticated to
    // chain X via this function (rather than mintAndAuth/mintAndDeposit
    // which DO subscribe) would never receive ownership-sync messages on
    // chain X after a future transfer — the previous owner could keep
    // posting as the username on chain X indefinitely. Audit fix
    // 2026-05-08 (H-1, CawProfile-agent finding).
    _addChosenChain(tokenId, lzDestId);

    if (lzDestId == mainnetLzId) {
      cawProfileL2.auth(tokenId, cawNetworkId);
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      uint64[] memory stamps;
      (tokenIds, owners, stamps) = extractPendingTransferUpdates(lzDestId, owner, tokenId);
      bytes memory payload = abi.encodeWithSelector(_authSelector, cawNetworkId, tokenId, tokenIds, owners, stamps);
      lzSend(cawNetworkId, lzDestId, _authSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  /// @notice Broadcast the current allow-free-auth state for `networkId` to `lzDestId`.
  ///         The state is derived from the network's authFee: zero fee → allow=true, non-zero → allow=false.
  ///         Callers must supply enough msg.value to cover the LZ fee (use
  ///         `broadcastAllowFreeAuthQuote` on CawProfileQuoter). Any excess is refunded to tx.origin.
  ///
  ///         Operator discipline: call this AFTER `setAuthFee` whenever the fee transitions
  ///         between zero and non-zero. Within-bucket changes (0.001→0.002) need no broadcast.
  ///
  /// @dev Permissionless: anyone can call this. Reading the current authFee from NetworkManager
  ///      and sending it via LZ is idempotent and non-harmful — the worst a griefing caller
  ///      can do is re-send the current state (no-op on L2) at their own gas cost.
  /// @param networkId The network whose free-auth state to propagate.
  /// @param lzDestId The L2 endpoint ID (storage chain EID for this network).
  /// @param lzTokenAmount LZ ZRO token amount (0 to pay in native gas).
  function broadcastAllowFreeAuth(uint32 networkId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    bool allow = (networkManager.getAuthFee(networkId) == 0);
    bytes memory payload = abi.encodeWithSelector(_allowFreeAuthSelector, networkId, allow);
    if (lzDestId == mainnetLzId) {
      cawProfileL2.setAllowFreeAuth(networkId, allow);
      _refundUnusedLzEth(msg.value);
    } else {
      // n=0: no per-token ownership entries in this payload.
      lzSend(networkId, lzDestId, _allowFreeAuthSelector, 0, payload, msg.value, lzTokenAmount);
    }
  }

  /// @notice Deposit CAW into a token on behalf of its owner. CAW is pulled from msg.sender
  ///         (not the token owner), so the caller must have approved this contract for CAW.
  ///         This allows router contracts to collect CAW from the user and deposit in one flow.
  function depositFor(uint32 cawNetworkId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    address owner = ownerOf(tokenId);

    // depositFor is intentionally permissionless (routers pay-on-behalf-of),
    // but a zero-amount call lets a third party permanently mark a token
    // as subscribed to chains the owner never opted into, plus auth them
    // to networks they didn't pick. Require a non-zero deposit so the caller
    // at least has economic skin in the game. Audit fix 2026-05-08 (M-2).
    if (amount == 0) revert ZeroDeposit();

    _addChosenChain(tokenId, lzDestId);
    CAW.transferFrom(msg.sender, address(this), amount);
    totalCaw += amount;

    // Pay deposit + auth fees through their respective getters so the
    // accounting routes to the right addresses. NetworkManager today
    // returns the same feeAddress for every fee type (single per-Network
    // recipient), so the user-visible behavior is unchanged — but if a
    // future NetworkManager upgrade splits them per fee, this path
    // already routes correctly. Audit fix 2026-05-17 H-1.
    (uint256 depositFee, address depositFeeAddr) = networkManager.getDepositFeeAndAddress(cawNetworkId);
    uint256 totalFeesPaid = payFee(depositFee, depositFeeAddr);

    if (!authenticated[cawNetworkId][tokenId]) {
      (uint256 authFee, address authFeeAddr) = networkManager.getAuthFeeAndAddress(cawNetworkId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
      authenticated[cawNetworkId][tokenId] = true;
      _lockWithdrawFeeIfNeeded(cawNetworkId, tokenId);
    }

    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.deposit(cawNetworkId, tokenId, amount);
      _refundUnusedLzEth(lzEthAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      uint64[] memory stamps;
      (tokenIds, owners, stamps) = extractPendingTransferUpdates(lzDestId, owner, tokenId);
      bytes memory payload = abi.encodeWithSelector(_addToBalanceSelector, cawNetworkId, tokenId, amount, tokenIds, owners, stamps);
      lzSend(cawNetworkId, lzDestId, _addToBalanceSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }

    emit Deposited(cawNetworkId, tokenId, amount, lzDestId, msg.sender);
  }

  function deposit(uint32 cawNetworkId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    if (ownerOf(tokenId) != msg.sender) revert NotOwner();
    depositFor(cawNetworkId, tokenId, amount, lzDestId, lzTokenAmount);
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

  function withdraw(uint32 cawNetworkId, uint32 tokenId, uint256 lzTokenAmount) public payable {
    withdrawTo(cawNetworkId, tokenId, msg.sender, lzTokenAmount);
  }

  /// @notice Withdraw CAW to any address. Only callable by the token owner.
  function withdrawTo(uint32 cawNetworkId, uint32 tokenId, address recipient, uint256 lzTokenAmount) public payable {
    if (ownerOf(tokenId) != msg.sender) revert NotOwner();
    if (withdrawable[tokenId] == 0) revert NothingToWithdraw();
    if (recipient == address(0)) revert ZeroAddr();

    uint256 amount = withdrawable[tokenId];
    totalCaw -= withdrawable[tokenId];
    withdrawable[tokenId] = 0;

    (uint256 currentFee, address feeAddress) = networkManager.getWithdrawFeeAndAddress(cawNetworkId);
    uint256 fee = currentFee;
    if (withdrawFeeLocked[cawNetworkId][tokenId]) {
      uint256 locked = lockedWithdrawFee[cawNetworkId][tokenId];
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
    if (!(owner == msg.sender || isApprovedForAll(owner, msg.sender) || getApproved(tokenId) == msg.sender)) revert NotApproved();
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
    if (updatesNeededForPeer(lzDestId) == 0) revert NoPending();
    _updateNewOwners(lzDestId, msg.value, lzTokenAmount);
  }

  // ============================================
  // REPLICATION CONFIG SYNC
  // ============================================

  // Replication-chain sync to L2 has been removed. Per-validator REPLICATE_NETWORK_IDS
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
    //      this branch, withdrawals on L1-storage (bypassLZ) networks
    //      silently lose CAW: L2's setWithdrawable bypassLZ branch calls
    //      this function directly, but a fromLZ-only gate would always
    //      revert and the WITHDRAW action's L2 debit (which already
    //      happened in CawActions._applyAction.withdrawTokens) would
    //      have no L1 counterpart. Audit fix 2026-05-08 (C-1).
    if (!(fromLZ || msg.sender == address(cawProfileL2))) revert NotL2Mirror();
    for (uint256 i = 0; i < tokenIds.length; i++)
      withdrawable[tokenIds[i]] += amounts[i];
  }

  /// @dev Add lzDestId to the token's chosen-chain set. Reverts if the set would exceed
  ///      MAX_CHOSEN_CHAINS; the cap prevents an attacker from growing the set until
  ///      _afterTokenTransfer iterates enough entries to exceed block gas (H-3 fix).
  function _addChosenChain(uint32 tokenId, uint32 lzDestId) internal {
    if (chosenChainIds[tokenId].length() >= MAX_CHOSEN_CHAINS) revert TooManyChains();
    chosenChainIds[tokenId].add(uint256(lzDestId));
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
      if (chainId == mainnetLzId) cawProfileL2.setOwnerOf(token, to, uint64(block.number));
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

  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) public view returns (uint32[] memory, address[] memory, uint64[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);
    uint64[] memory stamps = new uint64[](updateCount + includeOwner);
    uint64 stamp = uint64(block.number);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId] + i];
      owners[i] = ownerOf(tokenIds[i]);
      stamps[i] = stamp;
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
      stamps[updateCount] = stamp;
    }

    return (tokenIds, owners, stamps);
  }

  function extractPendingTransferUpdates(uint32 lzDestId) internal returns (uint32[] memory, address[] memory, uint64[] memory) {
    return extractPendingTransferUpdates(lzDestId, address(0), 0);
  }

  function extractPendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) internal returns (uint32[] memory, address[] memory, uint64[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);
    uint64[] memory stamps = new uint64[](updateCount + includeOwner);
    uint64 stamp = uint64(block.number);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      delete pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      owners[i] = ownerOf(tokenIds[i]);
      stamps[i] = stamp;
      pendingTransferStart[lzDestId]++;
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
      stamps[updateCount] = stamp;
    }

    return (tokenIds, owners, stamps);
  }

  /// @dev updateOwners messages sync the entire pending-transfer queue across all
  ///      tokens regardless of which network they're authed to, so the gas budget
  ///      reads `networkGasOverride[0][updateOwnersSelector]` — networkId=0 is
  ///      reserved for protocol-wide overrides. CawNetworkManager.setGasOverride
  ///      can't write networkId=0 (no owner), so this slot stays at 0 forever
  ///      unless a future amendment adds a controlled path. Acceptable: the
  ///      updateOwners handler is the lowest-risk one in the system.
  function _updateNewOwners(uint32 lzDestId, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    // Sentinel 0 from peerWithMaxPendingTransfers means "no peers
    // configured" — nothing to flush. See M-3 fix above.
    if (lzDestId == 0) return;

    uint32[] memory tokenIds;
    address[] memory owners;
    uint64[] memory stamps;

    (tokenIds, owners, stamps) = extractPendingTransferUpdates(lzDestId);
    if (tokenIds.length > 0) {
      if (lzDestId == mainnetLzId)
        cawProfileL2.updateOwners(tokenIds, owners, stamps);
      else {
        bytes memory payload = abi.encodeWithSelector(_updateOwnersSelector, tokenIds, owners, stamps);
        lzSend(0, lzDestId, _updateOwnersSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
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
    bytes4 decodedSelector = bytes4(payload);

    // Ensure the selector corresponds to an expected function to prevent unauthorized actions
    if (!(isAuthorizedFunction(decodedSelector))) revert Unauthorized();

    // Copy payload to memory for delegatecall (payload IS selector++args).
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
    (bool success, bytes memory returnData) = address(this).delegatecall(payload);
    fromLZ = false;

    // Handle failure and revert with the error message
    if (!success) {
      // If the returndata is empty, use a generic error message
      if (returnData.length == 0) {
        revert DelegateFailed();
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
  // which doesn't allow for networks to take native fees alongside LZ.
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256 nativeFee) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return _nativeFee;
  }

  function lzSend(uint32 cawNetworkId, uint32 lzDestId, bytes4 selector, uint256 n, bytes memory payload, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(cawNetworkId, selector, n), 0);

    // Piggyback a 36-byte price sample (uint256 cumulative + uint32 timestamp)
    // onto every L1->L2 message. CawProfileL2._lzReceive strips this prefix
    // and passes it to CawCapOracle.recordSample before dispatching the
    // primary payload. If no priceReader is configured the prefix is zeroed;
    // the L2 oracle silently skips samples with timestamp 0 (non-monotonic).
    uint256 cumulative;
    uint32 priceTs;
    if (address(priceReader) != address(0)) {
      (cumulative, priceTs) = priceReader.readSample();
    }

    // Refund excess LZ fee to tx.origin — the EOA that actually paid.
    // Using msg.sender would break when called through an intermediary contract
    // (e.g. CawProfileMarketplace.acceptOffer -> transferAndSync) because the contract
    // wouldn't have a receive() function to accept the refund.
    _lzSend(
      lzDestId, // Destination chain's endpoint ID.
      abi.encodePacked(cumulative, priceTs, payload), // price prefix + original payload
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(lzEthAmount, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(tx.origin) // Refund excess LZ fee to the tx originator (the EOA paying)
    );
  }


  // Most quote functions moved to CawProfileQuoter contract to reduce contract size
  // lzQuote stays here since it needs access to inherited _quote from OApp

  function lzQuote(uint32 cawNetworkId, bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(cawNetworkId, selector, n), 0);
    // The piggyback prepends a 36-byte price-sample prefix (uint256 + uint32)
    // to every L1→L2 message. Quote against the padded size so the fee matches
    // what _lzSend actually sends. Using encodePacked with zero values is
    // byte-for-byte identical to the real prefix (LZ fees depend on message
    // size, not content).
    return _quote(lzDestId, abi.encodePacked(uint256(0), uint32(0), payload), _options, _payInLzToken);
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
  ///      `networkGasOverride` from CawNetworkManager is added on top — see that contract
  ///      for the per-network ratchet that lets a network owner bump this budget if some
  ///      future EVM/L2/LZ change ever undersizes a path. Cap'd at MAX_GAS_OVERRIDE so
  ///      a compromised network owner can't grief their own users with arbitrary fees.
  function gasLimitFor(uint32 cawNetworkId, bytes4 selector, uint256 n) internal view returns (uint128) {
    // Unset selectors return 0 here; the LZ send downstream will OOG meaningfully on the
    // L2 receive call (gas budget far below any handler's needs), so a bad selector still
    // reverts — just without an explicit require message in this hot path.
    // Per-token cost: 19k SSTORE (ownerOf, warm) + 22k (lastOwnerUpdateBlock cold)
    // + 22k (ownerSessionEpoch++ on prev-owner-out, cold)
    // + 22k (tokenSessionEpoch[tokenId]++ cold, token-scoped-session invalidation). Plus arithmetic/loop overhead.
    return gasBaseFor[selector] + uint128(65_000 * n) + networkManager.networkGasOverride(cawNetworkId, selector);
  }

  /// @notice Returns all 7 L2 handler selectors in a single call.
  /// @dev Single dispatcher entry instead of 7 — reduces bytecode. Callers
  ///      (CawProfileQuoter) call this once and cache the results locally.
  function selectors() external pure returns (
    bytes4 mint,
    bytes4 addToBalance,
    bytes4 auth,
    bytes4 updateOwners,
    bytes4 mintAuth,
    bytes4 depositRegisterSession,
    bytes4 mintAuthRegisterSession
  ) {
    return (
      _mintSelector,
      _addToBalanceSelector,
      _authSelector,
      _updateOwnersSelector,
      _mintAuthSelector,
      _depositRegisterSessionSelector,
      _mintAuthRegisterSessionSelector
    );
  }

  /// @notice Returns the L2 handler selector for setAllowFreeAuth. Used by CawProfileQuoter
  ///         to build the broadcastAllowFreeAuthQuote without hardcoding the selector.
  function selectorAllowFreeAuth() external pure returns (bytes4) { return _allowFreeAuthSelector; }

  receive() external payable {}
  fallback() external payable {}

}

