// contracts/CawProfileMinter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "./interfaces/IMint.sol";
import "./interfaces/ISmartEOA.sol";
import "./ISwapRouter.sol";

/// @dev Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
///      "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
contract CawProfileMinter is Context {

  mapping(string => uint32) public idByUsername;

  IMint CawProfile;
  IERC20 CAW;

  // Uniswap V2 router for ZAP flows: pay-with-ETH → swap → CAW → mint/deposit.
  // The path is always [WETH, CAW]. Slippage is enforced via user-supplied
  // `minCawOut`. The frontend reads pool reserves and computes the floor.
  ISwapRouter public immutable swapRouter;
  address public immutable WETH;

  // ============================================
  // SPONSOR ENTRY POINTS — EIP-712 domain + nonce constants
  // ============================================
  // Three action types for per-(contract,actionType) nonce namespacing.
  // Values must remain stable — changing them invalidates all outstanding permits.
  uint8 internal constant ACTION_MINT_DEPOSIT = 1;
  uint8 internal constant ACTION_DEPOSIT_FOR  = 2;
  uint8 internal constant ACTION_AUTHENTICATE = 3;

  // ERC-1271 magic value from the standard.
  bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

  /// @dev Gas cap for the ERC-1271 isValidSignature staticcall.
  ///
  ///      MEASURED COST (SmartEOAGas.t.sol, foundry mock P-256):
  ///        1 enrolled passkey:   ~55,500 gas (direct isValidSignature call)
  ///        3 enrolled passkeys:  ~61,000 gas (worst-case: match on last key)
  ///        Real P-256 precompile adds ~6,500 gas over mock → ~67,500 worst-case
  ///
  ///      WHY THE OLD VALUE (50k) WAS WRONG:
  ///        SmartEOA.isValidSignature (WebAuthn path) calls _verifyWebAuthnSafe,
  ///        which does a SELF-STATICCALL to _verifyWebAuthnExternal.  The EVM
  ///        63/64 gas forwarding rule means the inner call receives at most
  ///        floor(gas_remaining * 63/64) gas.  On a 50k budget the inner call
  ///        ran dry at ~49k gas used (confirmed: Sepolia tx
  ///        0x4c15ab98c1a5dee747da8a7afa9906e9216651bae3f2371063110dafd7230a10
  ///        via Infura debug_traceTransaction).  isValidSignature returned
  ///        0xffffffff (fail value), _checkPermit reverted "Bad sig",
  ///        SmartEOA.initialize wrapped as MinterCallFailed.
  ///
  ///      WHY 150k:
  ///        Worst-case measured: ~67,500 gas (3 passkeys, real P-256 precompile).
  ///        150k = ~2.2x headroom.  Handles clientDataJSON origin string variance,
  ///        future passkey count growth (each additional key adds ~5,500 gas/miss),
  ///        and any EVM repricing.
  ///
  ///      ABUSE PREVENTION is preserved:
  ///        The cap still bounds a malicious ERC-1271 wallet to at most 150k gas
  ///        wasted per _checkPermit call.  The sponsor sets the outer tx gas limit;
  ///        a bad wallet cannot cause the sponsor tx to OOG beyond ERC1271_GAS_LIMIT.
  ///        (The old 50k bound was tighter but broke legitimate SmartEOA users.)
  ///
  ///      NOTE: CawActions.sol and CawActionsERC1271.sol have their own copies of
  ///        ERC1271_GAS_LIMIT = 50k (immutable on-chain).  Those only call
  ///        isValidSignature with the 65-byte secp256k1 path (pass sig as r||s||v),
  ///        which costs ~800 gas — so 50k is fine there.  The WebAuthn path is only
  ///        exercised through the sponsored Minter entry points fixed here.
  uint256 internal constant ERC1271_GAS_LIMIT = 150_000;

  // EIP-712 domain separator — bakes chainId + address(this) at deploy time
  // so permits signed for one chain/deployment cannot be replayed on another.
  bytes32 public immutable DOMAIN_SEPARATOR;

  // EIP-712 struct type hashes — keccak256 is evaluated at compile time as a
  // constant expression.
  bytes32 internal constant MINT_DEPOSIT_TYPEHASH = keccak256(
    "MintAndDeposit(uint32 networkId,address recipient,string username,uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce,uint8 kycLevel,uint32 sponsorTokenId,uint256 repayAmount)"
  );

  bytes32 internal constant DEPOSIT_FOR_TYPEHASH = keccak256(
    "DepositFor(uint32 networkId,uint32 tokenId,uint256 amount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)"
  );

  bytes32 internal constant AUTHENTICATE_TYPEHASH = keccak256(
    "Authenticate(uint32 networkId,uint32 tokenId,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)"
  );

  constructor(
    address _caw,
    address _cawProfiles,
    address _router,
    address _pathwayExpander
  ) {
    if (_pathwayExpander == address(0)) revert ZeroAddr();
    CAW = IERC20(_caw);
    CawProfile = IMint(_cawProfiles);
    swapRouter = ISwapRouter(_router);
    WETH = swapRouter.WETH();
    pathwayExpander = _pathwayExpander;

    // Compute EIP-712 domain separator once at deploy time.
    DOMAIN_SEPARATOR = keccak256(abi.encode(
      keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      keccak256(bytes("CawProfileMinter")),
      keccak256(bytes("1")),
      block.chainid,
      address(this)
    ));
  }

  // ============================================
  // PRIMARY ENTRYPOINTS — user mints for themselves
  // ============================================
  // The plain `mint` / `mintAndAuth` / `mintAndDeposit` functions are thin
  // recipient=msg.sender wrappers. The real work lives in their `*For`
  // variants below — same pattern as `deposit` ↔ `depositFor` on CawProfile,
  // so an external router contract can collect any currency from the user
  // and call `mintFor`/`mintAndAuthFor`/`mintAndDepositFor` on their behalf
  // (CAW for the burn + deposit comes from the router's balance).

  function mint(uint32 networkId, string memory username, uint256 lzTokenAmount) public payable {
    mintFor(networkId, msg.sender, username, lzTokenAmount);
  }

  function mintAndAuth(uint32 networkId, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndAuthFor(networkId, msg.sender, username, lzDestId, lzTokenAmount);
  }

  function mintAndDeposit(uint32 networkId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndDepositFor(networkId, msg.sender, username, depositAmount, lzDestId, lzTokenAmount);
  }

  /// @notice Bundled mint + deposit + auth + Quick Sign session — one tx, one wallet popup.
  /// @dev SELF-MINT ONLY by design: the recipient is always `msg.sender`, so the EOA that
  ///      paid gas is the wallet that gets the session attached. No `*For` variant exists —
  ///      that would let a third party register a session in someone else's wallet, which
  ///      we don't allow for bundled flows. WITHDRAW is permanently non-delegatable
  ///      (scopeBitmap hard-wired to 0xBF on L2).
  function mintAndDepositAndQuickSign(
    uint32 networkId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount,
    address sessionKey, uint64 expiry, uint256 spendLimit, uint64 perActionTipRate
  ) public payable {
    require(sessionKey != address(0), "Zero session key");
    uint32 newId = _burnAndAssignId(username, depositAmount, _msgSender());
    if (depositAmount > 0) {
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    bytes memory sessionExtra = abi.encode(sessionKey, expiry, spendLimit, perActionTipRate);
    CawProfile.mintAndDeposit{value: msg.value}(
      networkId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, sessionExtra, 0, 0
    );
  }

  /// @notice Bundled mint + auth + Quick Sign session (no deposit). Self-mint only — see
  ///         the security note on `mintAndDepositAndQuickSign`.
  function mintAndAuthAndQuickSign(
    uint32 networkId, string memory username, uint32 lzDestId, uint256 lzTokenAmount,
    address sessionKey, uint64 expiry, uint256 spendLimit, uint64 perActionTipRate
  ) public payable {
    require(sessionKey != address(0), "Zero session key");
    uint32 newId = _burnAndAssignId(username, 0, _msgSender());
    bytes memory sessionExtra = abi.encode(sessionKey, expiry, spendLimit, perActionTipRate);
    CawProfile.mintAndAuth{value: msg.value}(
      networkId, msg.sender, username, newId, lzDestId, lzTokenAmount, sessionExtra
    );
  }

  // ============================================
  // *For VARIANTS — caller pays in CAW, NFT goes to `recipient`
  // ============================================
  // Note: there is intentionally NO `*For` variant of the bundled Quick Sign flows.
  // Bundled session registration is self-mint only — see security note on
  // `mintAndDepositAndQuickSign`.

  /// @notice Mint a username on behalf of `recipient`. The burn-cost CAW is pulled from
  ///         `msg.sender`, but the Profile NFT (and ownership of any future deposit) goes
  ///         to `recipient`. Mirrors depositFor's pattern so external routers can offer
  ///         "pay in <other-currency>, get a CAW Profile" without holding the user's CAW.
  function mintFor(uint32 networkId, address recipient, string memory username, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0, _msgSender());
    CawProfile.mint{value: msg.value}(networkId, recipient, username, newId, lzTokenAmount);
  }

  /// @notice mintAndAuth on behalf of `recipient`. The burn cost is pulled from msg.sender.
  function mintAndAuthFor(uint32 networkId, address recipient, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0, _msgSender());
    CawProfile.mintAndAuth{value: msg.value}(networkId, recipient, username, newId, lzDestId, lzTokenAmount, "");
  }

  /// @notice mintAndDeposit on behalf of `recipient`. burn + deposit CAW is pulled from
  ///         msg.sender; the NFT and the deposit credit go to `recipient`.
  function mintAndDepositFor(uint32 networkId, address recipient, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, depositAmount, _msgSender());
    if (depositAmount > 0) {
      // Pull the deposit portion into this contract and approve CawProfile to pull it back —
      // mirrors the original mintAndDeposit pattern (CawProfile expects the deposit CAW
      // to be transferable from the Minter's allowance during its mintAndDeposit call).
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    CawProfile.mintAndDeposit{value: msg.value}(networkId, recipient, username, newId, depositAmount, lzDestId, lzTokenAmount, "", 0, 0);
  }

  // ============================================
  // WITHDRAW GATE — implements ICawWithdrawGate
  // ============================================
  // KYC state lives here (not on CawProfile) — CawProfile is near the EIP-170
  // 24,576-byte cap. CawProfile.withdrawTo calls checkWithdrawAllowed(tokenId, owner)
  // on this contract as an external view; if the gate is closed this reverts.
  //
  // Levels:
  //   0 = no gate (sponsor gift / repay-only / casual sponsorship)
  //   1 = 180-day time-lock, no KYC ("stored-value" regulatory framing for fiat mints)
  //   2+ = KYC verifier required at that level (IKycVerifier adapter, e.g. Civic Pass)
  //
  // The level is chosen by the sponsor at mint time and stored per-tokenId. Levels
  // 1 and ≥2 are mutually exclusive paths — level 1 cannot be unlocked early by
  // KYC, and levels ≥2 cannot be waited out. Self-funded mints never write
  // mintedAt and are unconditionally lock-free regardless of any level value.

  /// @dev Per-tokenId withdraw lock level. Set by mintAndDepositSponsored at mint
  ///      time when kycLevel > 0. 0 = unlocked (no restriction). 1 = time-lock.
  ///      2+ = KYC verifier required.
  mapping(uint32 => uint8) public withdrawKycLevel;
  /// @dev Mint timestamp for time-lock calculation. 0 = not locked.
  mapping(uint32 => uint256) public mintedAt;

  uint256 internal constant WITHDRAW_TIMELOCK = 180 days;

  /// @dev Sentinel level for the time-lock-only path. Verifier slots start at 2 —
  ///      addKycVerifier rejects this slot so a future PathwayExpander owner can't
  ///      install a verifier that checkWithdrawAllowed would never reach (the
  ///      level == TIME_LOCK_LEVEL branch returns before the verifier lookup).
  uint8 internal constant TIME_LOCK_LEVEL = 1;

  /// @notice Per-level KYC verifier adapter addresses.
  ///         level 0 = no gate (no verifier needed; not stored here).
  ///         level 1 = time-lock only (no verifier needed; not stored here).
  ///         level 2+ = IKycVerifier adapter (Civic Pass network, etc).
  /// @dev    Additions-only: PathwayExpander can set a new level via
  ///         `addKycVerifier`, but a level that already points at a non-zero
  ///         verifier can never be rewritten. Same security pattern as
  ///         PathwayExpander.addPeer (peers[eid] == 0 guard) — a compromised
  ///         expander key can grow the KYC surface but can't redirect an
  ///         existing level to an attacker-controlled adapter.
  mapping(uint8 => address) public kycVerifiers;

  /// @notice The PathwayExpander on this chain. Sole address authorized to
  ///         call `addKycVerifier`. Immutable; same role/lifecycle as
  ///         CawProfile.owner() (set at deploy, never rotated).
  address public immutable pathwayExpander;

  error KycRequired();
  error KycNotConfigured();
  error AlreadyUnlocked();
  error NotTokenOwner();
  error WithdrawTimelocked();
  error ZeroAddr();
  error NotPathwayExpander();
  error LevelAlreadySet();

  event WithdrawUnlocked(uint32 indexed tokenId);
  event KycVerifierAdded(uint8 indexed level, address indexed verifier);

  /// @notice Register the IKycVerifier adapter for a new KYC level.
  ///         Only PathwayExpander can call this. A level that already
  ///         points at a non-zero verifier reverts — no rotation, only
  ///         additions. To swap an adapter for an existing level, redeploy
  ///         the whole Minter (CawProfile.minter is immutable, so this also
  ///         forces a CawProfile redeploy — a clean break).
  function addKycVerifier(uint8 level, address verifier) external {
    if (msg.sender != pathwayExpander) revert NotPathwayExpander();
    // Verifier slots start at level 2. Level 0 = no gate, level 1 = time-lock.
    // Neither has (or needs) a verifier; installing one at those slots would be
    // dead state, since checkWithdrawAllowed's level == TIME_LOCK_LEVEL branch
    // (and the level == 0 early-return) never reaches the verifier lookup.
    if (level < 2) revert KycNotConfigured();
    if (verifier == address(0)) revert ZeroAddr();
    if (kycVerifiers[level] != address(0)) revert LevelAlreadySet();
    kycVerifiers[level] = verifier;
    emit KycVerifierAdded(level, verifier);
  }

  /// @notice Returns the verifier address for a given KYC level.
  function kycVerifierFor(uint8 level) external view returns (address) {
    return kycVerifiers[level];
  }

  /// @notice Called by CawProfile.withdrawTo to enforce the withdraw gate.
  ///         Reverts if the token is still locked. No-op if not locked.
  /// @param tokenId    The profile token to check.
  /// @param tokenOwner Address of the token owner (supplied by CawProfile to avoid
  ///                   a second ownerOf call inside the gate check).
  function checkWithdrawAllowed(uint32 tokenId, address tokenOwner) external view {
    uint8 level = withdrawKycLevel[tokenId];
    uint256 minted = mintedAt[tokenId];
    if (minted == 0) return; // not locked (level 0, or never gated)
    if (level == TIME_LOCK_LEVEL) {
      if (block.timestamp >= minted + WITHDRAW_TIMELOCK) return;
      revert WithdrawTimelocked();
    }
    // level >= 2: KYC verifier required, no time-fallback
    address verifier = kycVerifiers[level];
    if (verifier == address(0)) revert KycNotConfigured();
    (bool ok, bytes memory ret) = verifier.staticcall(
      abi.encodeWithSignature("isVerified(address)", tokenOwner)
    );
    if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert KycRequired();
  }

  /// @notice Token owner calls this to unlock withdrawals once KYC or time-lock is satisfied.
  ///         Clears the lock state — subsequent withdrawals are unrestricted.
  function unlockWithdraw(uint32 tokenId) external {
    if (CawProfile.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
    uint8 level = withdrawKycLevel[tokenId];
    uint256 minted = mintedAt[tokenId];
    if (minted == 0) revert AlreadyUnlocked();
    if (level == TIME_LOCK_LEVEL) {
      require(block.timestamp >= minted + WITHDRAW_TIMELOCK, "Timelock active");
    } else {
      // level >= 2: KYC verifier required, no time-fallback
      address verifier = kycVerifiers[level];
      if (verifier == address(0)) revert KycNotConfigured();
      (bool ok, bytes memory ret) = verifier.staticcall(
        abi.encodeWithSignature("isVerified(address)", msg.sender)
      );
      require(ok && ret.length >= 32 && abi.decode(ret, (bool)), "KycRequired");
    }
    delete withdrawKycLevel[tokenId];
    delete mintedAt[tokenId];
    emit WithdrawUnlocked(tokenId);
  }

  /// @dev Shared prologue for every mint path: validate the username, take the burn cost
  ///      from `funder`, register the new tokenId, and return it. `extraCawNeeded` is the
  ///      additional CAW `funder` must hold + have approved beyond burnAmount (e.g. the
  ///      deposit portion in mintAndDepositFor). Pulling the extra is the caller's job —
  ///      this function only verifies the headroom and burns the burn portion.
  ///
  /// @param funder        Address whose CAW balance + allowance is checked and burned.
  ///                      For normal (non-sponsored) paths this is _msgSender().
  ///                      For sponsored (EIP-7702) paths this is tx.origin (the sponsor
  ///                      server's EOA that broadcasts the type-0x04 tx and holds the CAW).
  ///                      See _burnAndAssignIdFor note for full rationale.
  function _burnAndAssignId(string memory username, uint256 extraCawNeeded, address funder) internal returns (uint32 newId) {
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");
    uint256 burnAmount = costOfName(username);
    uint256 totalCawNeeded = burnAmount + extraCawNeeded;

    require(CAW.balanceOf(funder) >= totalCawNeeded, "You do not have enough CAW to make this purchase");
    require(CAW.allowance(funder, address(this)) >= totalCawNeeded, "You must approve spending of your CAW");
    CAW.transferFrom(funder, address(0xdEAD000000000000000042069420694206942069), burnAmount);

    newId = CawProfile.nextId();
    idByUsername[username] = newId;
  }

  function isValidUsername(string memory _input) public pure returns (bool) {
    bytes memory input = bytes(_input);
    if (input.length == 0 || input.length > 255) return false;

    for (uint256 i = 0; i < input.length; i++) {
      uint8 char = uint8(input[i]);
      if (
        (char < 48 || char > 57) && // not a number
          (char < 97 || char > 122) // not a lowercase character
      ) return false;
    }

    return true;
  }

  // ============================================
  // ZAP FLOWS — pay with ETH, contract swaps to CAW via Uniswap V2
  // ============================================
  // These let new users onboard or existing users top up paying ETH instead
  // of CAW. msg.value carries BOTH the swap input AND the LZ + storage fees;
  // the frontend computes the split and passes `swapEthAmount` explicitly.
  // `minCawOut` is the user's slippage floor — enforced inside the router
  // call (revert if the swap returns less, leaving msg.value untouched).
  //
  // Self-mint only by design (no `*For` ZAP variants), matching the bundled
  // QuickSign security stance: the recipient is always msg.sender, so the
  // swap output and resulting NFT/session land on the caller's account.

  /// @notice Existing-holder top-up: swap ETH → CAW, then deposit the full output.
  /// @param swapEthAmount Portion of msg.value to spend on the Uniswap swap.
  ///        Remainder (msg.value - swapEthAmount) is forwarded as LZ + storage fees.
  /// @param minCawOut Slippage floor enforced by the router.
  function depositZap(
    uint32 cawNetworkId,
    uint32 tokenId,
    uint256 swapEthAmount,
    uint256 minCawOut,
    uint32 lzDestId,
    uint256 lzTokenAmount
  ) public payable {
    require(swapEthAmount > 0 && swapEthAmount <= msg.value, "Bad swap amount");
    uint256 cawReceived = _swapEthForCaw(swapEthAmount, minCawOut);
    CAW.approve(address(CawProfile), cawReceived);
    CawProfile.depositFor{value: msg.value - swapEthAmount}(
      cawNetworkId, tokenId, cawReceived, lzDestId, lzTokenAmount
    );
  }

  /// @notice New-user onboarding paying purely with ETH. Username availability
  ///         is checked BEFORE the swap so a frontrun-mint reverts without
  ///         spending any ETH on Uniswap.
  function mintAndDepositZap(
    uint32 networkId,
    string memory username,
    uint256 swapEthAmount,
    uint256 minCawOut,
    uint32 lzDestId,
    uint256 lzTokenAmount
  ) public payable {
    require(swapEthAmount > 0 && swapEthAmount <= msg.value, "Bad swap amount");
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");

    uint256 burnAmount = costOfName(username);
    uint256 cawReceived = _swapEthForCaw(swapEthAmount, minCawOut);
    require(cawReceived >= burnAmount, "Swap output < burn cost");

    CAW.transfer(address(0xdEAD000000000000000042069420694206942069), burnAmount);
    uint256 depositAmount = cawReceived - burnAmount;

    uint32 newId = CawProfile.nextId();
    idByUsername[username] = newId;

    CAW.approve(address(CawProfile), depositAmount);
    CawProfile.mintAndDeposit{value: msg.value - swapEthAmount}(
      networkId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, "", 0, 0
    );
  }

  /// @notice mintAndDepositZap bundled with QuickSign session registration.
  ///         Self-mint only — recipient is always msg.sender, matching the
  ///         security stance on `mintAndDepositAndQuickSign`.
  function mintAndDepositAndQuickSignZap(
    uint32 networkId,
    string memory username,
    uint256 swapEthAmount,
    uint256 minCawOut,
    address sessionKey,
    uint64 expiry,
    uint256 spendLimit,
    uint64 perActionTipRate,
    uint32 lzDestId,
    uint256 lzTokenAmount
  ) public payable {
    require(sessionKey != address(0), "Zero session key");
    require(swapEthAmount > 0 && swapEthAmount <= msg.value, "Bad swap amount");
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");

    uint256 burnAmount = costOfName(username);
    uint256 cawReceived = _swapEthForCaw(swapEthAmount, minCawOut);
    require(cawReceived >= burnAmount, "Swap output < burn cost");

    CAW.transfer(address(0xdEAD000000000000000042069420694206942069), burnAmount);
    uint256 depositAmount = cawReceived - burnAmount;

    uint32 newId = CawProfile.nextId();
    idByUsername[username] = newId;

    CAW.approve(address(CawProfile), depositAmount);
    bytes memory sessionExtra = abi.encode(sessionKey, expiry, spendLimit, perActionTipRate);
    CawProfile.mintAndDeposit{value: msg.value - swapEthAmount}(
      networkId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, sessionExtra, 0, 0
    );
  }

  /// @dev Swap exact ETH for CAW via Uniswap V2. Path = [WETH, CAW], deadline
  ///      = block.timestamp + 600 (10 min — generous for the user, bounded for
  ///      MEV). The router enforces `minCawOut` and reverts on insufficient
  ///      output. Output lands in this contract; caller is responsible for
  ///      forwarding/approving it.
  function _swapEthForCaw(uint256 ethAmount, uint256 minCawOut) internal returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = WETH;
    path[1] = address(CAW);
    uint256[] memory amounts = swapRouter.swapExactETHForTokens{value: ethAmount}(
      minCawOut, path, address(this), block.timestamp + 600
    );
    return amounts[amounts.length - 1];
  }

  // ============================================
  // SPONSOR ENTRY POINTS — for ISmartEOA-compatible wallets
  // ============================================
  // All three functions follow the same pattern:
  //   1. Confirm the owner/recipient is a smart contract (code.length > 0).
  //      Plain EOAs (code.length == 0) must submit directly — no sponsor needed.
  //   2. Build the EIP-712 struct hash + final digest for this specific operation.
  //   3. Delegate to _checkPermit: read nonce, verify ERC-1271 sig, consume nonce.
  //   4. Forward to the existing CawProfile entry point.
  //
  // WALLET COMPATIBILITY (clarified after integration audit #52 M-1):
  //   The Minter staticcalls TWO interfaces on the owner/recipient: standard
  //   ERC-1271 isValidSignature(digest, sig) AND CAW-specific
  //   ISmartEOA.{nonceOf, consumeNonce} for replay protection. To use these
  //   sponsor entry points, the wallet contract MUST implement BOTH:
  //     - ERC-1271 isValidSignature returning 0x1626ba7e for the Minter's digest
  //     - ISmartEOA.nonceOf(verifyingContract, actionType) returning a uint256
  //     - ISmartEOA.consumeNonce(verifyingContract, actionType) gated to
  //       msg.sender == verifyingContract
  //
  //   SUPPORTED:
  //     * Population B: SmartEOA (the 7702 delegate) — implements both
  //     * Population C wallets that wrap their ERC-1271 surface with a CAW-
  //       compatible nonce shim (TBD per-wallet, v2 scope)
  //
  //   NOT SUPPORTED via sponsor path:
  //     * Vanilla Safe, Argent, or generic Coinbase Smart Wallet that do not
  //       expose nonceOf/consumeNonce. These wallets can still interact with
  //       CawProfile via the direct (non-sponsored) entry points.
  //
  //   The `recipient.code.length > 0` gate filters out Population A direct EOAs.
  //   The ISmartEOA nonce calls will revert cleanly for incompatible wallets —
  //   no funds are at risk, just a failed tx.

  /// @notice Mint a profile and deposit CAW on behalf of a smart-contract wallet.
  ///         The CAW burn + deposit is pulled from the sponsor's allowance; the NFT
  ///         and deposit balance go to `recipient`.  `recipient` must be a contract
  ///         (7702-delegated EOA or smart wallet).
  ///
  ///         SPONSOR ADDRESS SELECTION: see NatSpec below for the EIP-7702 funding
  ///         model.  Short version: EOA caller → payer = msg.sender; contract caller
  ///         (SmartEOA 7702 path) → payer = tx.origin (the broadcaster).
  ///
  ///         NOTE: `depositAmount = 0` is INTENTIONALLY permitted (matches the
  ///         non-sponsored `mintAndDepositFor` semantics — a user may want to
  ///         register a username with no initial CAW balance). Audit #8 INFO-2
  ///         flagged this as inconsistent with `depositForSponsored`'s zero-amount
  ///         guard, but the operations have different semantics: depositForSponsored
  ///         at amount=0 is a no-op (nonce burn with no side effect), while
  ///         mintAndDepositSponsored at depositAmount=0 still mints the NFT + name.
  ///         Sponsors should validate amounts off-chain before submitting.
  ///
  /// @param networkId       CAW network to register on.
  /// @param recipient       Smart-contract wallet that will own the new profile.
  /// @param username        Desired username (must pass isValidUsername).
  /// @param depositAmount   CAW to lock as balance (pulled from sponsor). Zero is allowed.
  /// @param lzDestId        LayerZero destination chain ID (0 = mainnet bypass).
  /// @param lzTokenAmount   Optional LZ ZRO payment (pass 0 for ETH-only fee).
  /// @param permitNonce     Must match recipient.nonceOf(address(this), ACTION_MINT_DEPOSIT).
  /// @param sig             ERC-1271 sig from recipient over the EIP-712 digest.
  /// @param kycLevel        Withdraw gate. 0 = no gate (gift / repay-only / casual).
  ///                        1 = 180-day time-lock, no KYC. 2+ = KYC verifier required
  ///                        at that level. See withdrawKycLevel comment for full table.
  /// @param sponsorTokenId  Sponsor's profile (L2-side repay credit destination). 0 if unused.
  /// @param repayAmount     L2-side repay obligation (wei). Capped at depositAmount * 2.
  ///
  /// @dev CAW FUNDING MODEL (EIP-7702 path):
  ///      In the Population-B onboarding flow the transaction is a type-0x04 EIP-7702 tx
  ///      where:
  ///        tx.origin  = sponsor server's EOA (broadcasts + pays gas; holds the CAW pool)
  ///        tx.to      = the user's SmartEOA address
  ///        SmartEOA.initialize → calls this function, making msg.sender = SmartEOA
  ///
  ///      The user's SmartEOA holds 0 CAW at bootstrap time.  Pulling from msg.sender
  ///      (the SmartEOA) would always revert "not enough CAW".  The correct payer is
  ///      tx.origin — the sponsor server that CHOSE to broadcast this tx, holds the
  ///      CAW pool, and pre-approved an unlimited allowance to this Minter.
  ///
  ///      SECURITY: tx.origin as payer is safe here because:
  ///        1. The sponsor pre-approved the Minter.  Without that approval the transfer
  ///           reverts, so no address can be drained involuntarily.
  ///        2. The sponsor broadcasts the tx — controlling tx.origin is the same as
  ///           consenting to the spend.  No third party can set tx.origin to the sponsor.
  ///        3. The user-signed permit already binds the mint parameters (recipient,
  ///           username, depositAmount, etc.), so the sponsor cannot redirect the
  ///           user's registered name or deposit to another token.
  ///        4. This pattern is equivalent to the *For variants on CawProfile where
  ///           msg.sender (a router) fronts the CAW on behalf of the recipient.
  ///
  ///      For non-7702 direct callers the tx.origin == msg.sender, so existing Population-A
  ///      sponsor flows that call mintAndDepositSponsored directly (not through a 7702 EOA)
  ///      continue to work without change.
  function mintAndDepositSponsored(
    uint32 networkId,
    address recipient,
    string memory username,
    uint256 depositAmount,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    uint256 permitNonce,
    bytes calldata sig,
    uint8 kycLevel,
    uint32 sponsorTokenId,
    uint256 repayAmount
  ) external payable {
    require(recipient.code.length > 0, "Direct submit required");
    require(repayAmount == 0 || repayAmount <= depositAmount * 2, "Repay cap");
    bytes32 structHash = keccak256(abi.encode(
      MINT_DEPOSIT_TYPEHASH,
      networkId,
      recipient,
      keccak256(bytes(username)),
      depositAmount,
      lzDestId,
      lzTokenAmount,
      permitNonce,
      kycLevel,
      sponsorTokenId,
      repayAmount
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    _checkPermit(recipient, ACTION_MINT_DEPOSIT, permitNonce, digest, sig);
    // EIP-7702 fix: derive the CAW funder address.
    //   - If msg.sender is an EOA (code.length == 0): payer = msg.sender.
    //     This is the direct Population-A path: sponsor server calls the Minter
    //     directly as an EOA, so msg.sender == tx.origin == sponsor.
    //   - If msg.sender is a contract (code.length > 0): payer = tx.origin.
    //     This is the Population-B 7702 path: SmartEOA.initialize calls the
    //     Minter, making msg.sender = SmartEOA (0 CAW). tx.origin = the sponsor
    //     server EOA that broadcast the type-0x04 tx, holds the CAW pool, and
    //     pre-approved this Minter. See NatSpec above for full security rationale.
    address sponsor = _msgSender().code.length == 0 ? _msgSender() : tx.origin;
    uint32 newId = _burnAndAssignId(username, depositAmount, sponsor);
    if (depositAmount > 0) {
      CAW.transferFrom(sponsor, address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    // Only write gate state when kycLevel > 0. Level 0 = no gate (gift / repay-
    // only / casual sponsorship). Repay enforcement is L2-side and orthogonal —
    // skipping the mintedAt write at level 0 also prevents repay-only sponsors
    // from accidentally activating a time-lock the gate would later read.
    if (kycLevel > 0) {
      withdrawKycLevel[newId] = kycLevel;
      mintedAt[newId] = block.timestamp;
    }
    if (repayAmount > 0) {
      emit SponsorRepaySet(newId, sponsorTokenId, repayAmount, depositAmount);
    }
    // Route LZ fee refund to `recipient` (the user), not to tx.origin (sponsor server).
    // Audit fix 2026-05-22 (H-1: tx.origin as LZ refund in sponsored flows).
    CawProfile.setLzRefundTo(payable(recipient));
    CawProfile.mintAndDeposit{value: msg.value}(
      networkId, recipient, username, newId, depositAmount, lzDestId, lzTokenAmount, "",
      sponsorTokenId, repayAmount
    );
    CawProfile.setLzRefundTo(payable(address(0)));
  }

  event SponsorRepaySet(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 repayAmount, uint256 depositAmount);

  /// @notice Deposit additional CAW into an existing token owned by a smart-contract wallet.
  ///         `depositFor` is permissionless on CawProfile, but this entry point adds
  ///         sig-gating so the sponsor is sure the owner authorised the deposit.
  ///
  ///         FUNDING MODEL: the sponsor (msg.sender — typically a sponsor server) holds the
  ///         user's CAW balance and has pre-approved this Minter for at least `amount`.
  ///         The Minter pulls `amount` from the sponsor, approves CawProfile to pull it
  ///         back, then delegates to CawProfile.depositFor. The deposit credit goes to
  ///         the token's current owner (not to msg.sender). Integration audit 2026-05-21
  ///         HIGH-1: this pull-and-approve was missing in the initial Step 3b implementation.
  ///
  /// @param networkId       CAW network.
  /// @param tokenId         Token whose balance to top up.
  /// @param amount          CAW amount to deposit (pulled from the sponsor msg.sender).
  /// @param lzDestId        LayerZero destination chain ID.
  /// @param lzTokenAmount   Optional LZ ZRO payment.
  /// @param permitNonce     Must match owner.nonceOf(address(this), ACTION_DEPOSIT_FOR).
  /// @param sig             ERC-1271 sig from the token owner over the EIP-712 digest.
  function depositForSponsored(
    uint32 networkId,
    uint32 tokenId,
    uint256 amount,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    uint256 permitNonce,
    bytes calldata sig
  ) external payable {
    // Reject zero-amount calls BEFORE _checkPermit consumes the user's nonce.
    // CawProfile.depositFor has its own ZeroDeposit guard but it fires after the
    // nonce was already consumed by _checkPermit, wasting the owner's permit slot.
    // Re-audit 2026-05-21 LOW.
    require(amount > 0, "Zero deposit");
    address owner = CawProfile.ownerOf(tokenId);
    require(owner.code.length > 0, "Direct submit required");
    bytes32 structHash = keccak256(abi.encode(
      DEPOSIT_FOR_TYPEHASH,
      networkId,
      tokenId,
      amount,
      lzDestId,
      lzTokenAmount,
      permitNonce
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    _checkPermit(owner, ACTION_DEPOSIT_FOR, permitNonce, digest, sig);

    // Pull CAW from the sponsor into the Minter, then approve CawProfile to pull
    // it back. Required because CawProfile.depositFor does
    // CAW.transferFrom(msg.sender, ...) where msg.sender is THIS contract — we
    // must have the balance + allowance before delegating. Matches the pattern
    // used by mintAndDepositFor at line ~159. The sponsor server must hold the
    // user's CAW and have pre-approved the Minter for at least `amount`.
    // Integration audit 2026-05-21 HIGH-1.
    //
    // EIP-7702 fix: derive the CAW funder the same way as mintAndDepositSponsored:
    //   msg.sender.code.length == 0  →  funder = msg.sender  (direct EOA call)
    //   msg.sender.code.length > 0   →  funder = tx.origin   (7702/SmartEOA path)
    // See mintAndDepositSponsored NatSpec for full security rationale.
    address depositSponsor = _msgSender().code.length == 0 ? _msgSender() : tx.origin;
    CAW.transferFrom(depositSponsor, address(this), amount);
    CAW.approve(address(CawProfile), amount);
    // Route LZ fee refund to the token owner (the user), not tx.origin (sponsor server).
    // Audit fix 2026-05-22 (H-1: tx.origin as LZ refund in sponsored flows).
    CawProfile.setLzRefundTo(payable(owner));
    CawProfile.depositFor{value: msg.value}(networkId, tokenId, amount, lzDestId, lzTokenAmount);
    CawProfile.setLzRefundTo(payable(address(0)));
  }

  /// @notice Authenticate an existing profile to a second CAW network via the Minter.
  ///         Trust chain: owner's ERC-1271 sig verified here → Minter calls
  ///         CawProfile.authenticateForMinter (which trusts msg.sender == minter).
  ///         Useful for Population B users who already have a deposited profile and
  ///         want to join a second Network with sponsored gas.
  ///
  /// @param networkId       CAW network to authenticate to.
  /// @param tokenId         Token to authenticate.
  /// @param lzDestId        LayerZero destination chain ID.
  /// @param lzTokenAmount   Optional LZ ZRO payment.
  /// @param permitNonce     Must match owner.nonceOf(address(this), ACTION_AUTHENTICATE).
  /// @param sig             ERC-1271 sig from the token owner over the EIP-712 digest.
  function authenticateSponsored(
    uint32 networkId,
    uint32 tokenId,
    uint32 lzDestId,
    uint256 lzTokenAmount,
    uint256 permitNonce,
    bytes calldata sig
  ) external payable {
    address owner = CawProfile.ownerOf(tokenId);
    require(owner.code.length > 0, "Direct submit required");
    bytes32 structHash = keccak256(abi.encode(
      AUTHENTICATE_TYPEHASH,
      networkId,
      tokenId,
      lzDestId,
      lzTokenAmount,
      permitNonce
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    _checkPermit(owner, ACTION_AUTHENTICATE, permitNonce, digest, sig);
    // Route LZ fee refund to the token owner (the user), not tx.origin (sponsor server).
    // Audit fix 2026-05-22 (H-1: tx.origin as LZ refund in sponsored flows).
    CawProfile.setLzRefundTo(payable(owner));
    CawProfile.authenticateForMinter{value: msg.value}(networkId, tokenId, lzDestId, owner, lzTokenAmount);
    CawProfile.setLzRefundTo(payable(address(0)));
  }

  /// @dev Shared permit-verification logic for all three sponsor entry points.
  ///
  ///      Steps:
  ///       1. Read current nonce from signer.nonceOf(address(this), actionType).
  ///          Passing address(this) means the Minter's own nonce sequence is read —
  ///          the gate in SmartEOA ensures only the Minter can advance that sequence.
  ///       2. Require caller-supplied permitNonce matches (prevents stale permit use).
  ///       3. Staticcall signer.isValidSignature(digest, sig) with gas cap
  ///          ERC1271_GAS_LIMIT (150k). SmartEOA WebAuthn path uses ~55-68k
  ///          (measured: includes self-staticcall + P-256 precompile + base64url
  ///          decode). The cap prevents arbitrary ERC-1271 wallets from consuming
  ///          unlimited gas; see ERC1271_GAS_LIMIT comment for full rationale.
  ///       4. Consume the nonce via signer.consumeNonce(address(this), actionType).
  ///          Because consumeNonce is gated to msg.sender == verifyingContract and
  ///          msg.sender here is address(this) (the Minter), the call will succeed
  ///          for the Minter's nonce sequence only.
  ///
  /// @param signer      Contract whose ERC-1271 / nonce we verify.
  /// @param actionType  One of ACTION_MINT_DEPOSIT / ACTION_DEPOSIT_FOR / ACTION_AUTHENTICATE.
  /// @param permitNonce Caller-supplied nonce — must equal signer.nonceOf(this, actionType).
  /// @param digest      EIP-712 final digest (keccak256("\x19\x01" || domainSep || structHash)).
  /// @param sig         Raw sig bytes forwarded verbatim to isValidSignature.
  function _checkPermit(
    address signer,
    uint8 actionType,
    uint256 permitNonce,
    bytes32 digest,
    bytes calldata sig
  ) internal {
    uint256 currentNonce = ISmartEOA(signer).nonceOf(address(this), actionType);
    require(permitNonce == currentNonce, "Nonce mismatch");
    (bool ok, bytes memory ret) = signer.staticcall{gas: ERC1271_GAS_LIMIT}(
      abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig)
    );
    require(
      ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC,
      "Bad sig"
    );
    ISmartEOA(signer).consumeNonce(address(this), actionType);
  }

  /// @notice Accept ETH refunds from CawProfile._refundUnusedLzEth. Without
  ///         this, the low-level call{value: amount}("") in _refundUnusedLzEth
  ///         reverts when the Minter is msg.sender, causing all bypassLZ mint
  ///         paths to fail. (H-1)
  receive() external payable {}

  function costOfName(string memory username) public pure returns (uint256) {
    uint8 usernameLength = uint8(bytes(username).length);
    uint256 amount;

    // FROM THE SPEC:
    //
    // Every username is unique, and may use a-z and 0-9,
    //   without the use of special characters (emojis, etc..,) or capital letters. 
    //
    // - Single Character username (rare!) BURN 1,000,000,000,000 ($89,985, $1,799,712, $17,997,120) 
    // - 2 Character username - BURN 240,000,000,000 CAW ($21,600, $432,000, $4,320,000) 
    // - 3 Character Username - BURN 60,000,000,000 CAW ($5400, $108,000, $1,080,000) 
    // - 4 Character Username - BURN 6,000,000,000 CAW ($540, $10,800 $108,000) 
    // - 5 Character username - BURN 200,000,000 CAW ($18, $360, $3600) 
    // - 6 Character username - BURN 20,000,000 CAW ($1.80, $36, $360) 
    // - 7 Character username -BURN 10,000,000 CAW (90c, $18, $180) 
    // - 8 Character and up username - BURN 1,000,000 CAW (9c, $1.80, $18) 


    if (usernameLength == 1)
      amount = 10 ** 12; // 1,000,000,000,000
    else if (usernameLength == 2)
      amount = 24 * 10 ** 10; // 240,000,000,000
    else if (usernameLength == 3)
      amount = 6 * 10 ** 10;  // 60,000,000,000
    else if (usernameLength == 4)
      amount = 6 * 10 ** 9;  // 6,000,000,000
    else if (usernameLength == 5)
      amount = 2 * 10 ** 8; // 200,000,000
    else if (usernameLength == 6)
      amount = 2 * 10 ** 7; // 20,000,000
    else if (usernameLength == 7)
      amount = 10 ** 7; // 10,000,000
    else amount = 10 ** 6; // 1,000,000

    return amount * 10**18;
  }
}
