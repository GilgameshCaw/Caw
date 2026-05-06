// contracts/CawProfileMinter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IMint.sol";
import "./ISwapRouter.sol";

contract CawProfileMinter is Context {

  mapping(string => uint32) public idByUsername;

  IMint CawProfile;
  IERC20 CAW;

  // Uniswap V2 router for ZAP flows: pay-with-ETH → swap → CAW → mint/deposit.
  // The path is always [WETH, CAW]. Slippage is enforced via user-supplied
  // `minCawOut`. The frontend reads pool reserves and computes the floor.
  ISwapRouter public immutable swapRouter;
  address public immutable WETH;

  constructor(address _caw, address _cawProfiles, address _router) {
    CAW = IERC20(_caw);
    CawProfile = IMint(_cawProfiles);
    swapRouter = ISwapRouter(_router);
    WETH = swapRouter.WETH();
  }

  // ============================================
  // PRIMARY ENTRYPOINTS — owner mints for themselves
  // ============================================
  // The plain `mint` / `mintAndAuth` / `mintAndDeposit` functions are thin
  // recipient=msg.sender wrappers. The real work lives in their `*For`
  // variants below — same pattern as `deposit` ↔ `depositFor` on CawProfile,
  // so an external router contract can collect any currency from the user
  // and call `mintFor`/`mintAndAuthFor`/`mintAndDepositFor` on their behalf
  // (CAW for the burn + deposit comes from the router's balance).

  function mint(uint32 clientId, string memory username, uint256 lzTokenAmount) public payable {
    mintFor(clientId, msg.sender, username, lzTokenAmount);
  }

  function mintAndAuth(uint32 clientId, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndAuthFor(clientId, msg.sender, username, lzDestId, lzTokenAmount);
  }

  function mintAndDeposit(uint32 clientId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndDepositFor(clientId, msg.sender, username, depositAmount, lzDestId, lzTokenAmount);
  }

  /// @notice Bundled mint + deposit + auth + Quick Sign session — one tx, one wallet popup.
  /// @dev SELF-MINT ONLY by design: the recipient is always `msg.sender`, so the EOA that
  ///      paid gas is the wallet that gets the session attached. No `*For` variant exists —
  ///      that would let a third party register a session in someone else's wallet, which
  ///      we don't allow for bundled flows. WITHDRAW is permanently non-delegatable
  ///      (scopeBitmap hard-wired to 0xBF on L2).
  function mintAndDepositAndQuickSign(
    uint32 clientId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount,
    address sessionKey, uint64 expiry, uint256 spendLimit, uint64 perActionTipRate
  ) public payable {
    require(sessionKey != address(0), "Zero session key");
    uint32 newId = _burnAndAssignId(username, depositAmount);
    if (depositAmount > 0) {
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    bytes memory sessionExtra = abi.encode(sessionKey, expiry, spendLimit, perActionTipRate);
    CawProfile.mintAndDeposit{value: msg.value}(
      clientId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, sessionExtra
    );
  }

  /// @notice Bundled mint + auth + Quick Sign session (no deposit). Self-mint only — see
  ///         the security note on `mintAndDepositAndQuickSign`.
  function mintAndAuthAndQuickSign(
    uint32 clientId, string memory username, uint32 lzDestId, uint256 lzTokenAmount,
    address sessionKey, uint64 expiry, uint256 spendLimit, uint64 perActionTipRate
  ) public payable {
    require(sessionKey != address(0), "Zero session key");
    uint32 newId = _burnAndAssignId(username, 0);
    bytes memory sessionExtra = abi.encode(sessionKey, expiry, spendLimit, perActionTipRate);
    CawProfile.mintAndAuth{value: msg.value}(
      clientId, msg.sender, username, newId, lzDestId, lzTokenAmount, sessionExtra
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
  function mintFor(uint32 clientId, address recipient, string memory username, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0);
    CawProfile.mint{value: msg.value}(clientId, recipient, username, newId, lzTokenAmount);
  }

  /// @notice mintAndAuth on behalf of `recipient`. The burn cost is pulled from msg.sender.
  function mintAndAuthFor(uint32 clientId, address recipient, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0);
    CawProfile.mintAndAuth{value: msg.value}(clientId, recipient, username, newId, lzDestId, lzTokenAmount, "");
  }

  /// @notice mintAndDeposit on behalf of `recipient`. burn + deposit CAW is pulled from
  ///         msg.sender; the NFT and the deposit credit go to `recipient`.
  function mintAndDepositFor(uint32 clientId, address recipient, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, depositAmount);
    if (depositAmount > 0) {
      // Pull the deposit portion into this contract and approve CawProfile to pull it back —
      // mirrors the original mintAndDeposit pattern (CawProfile expects the deposit CAW
      // to be transferable from the Minter's allowance during its mintAndDeposit call).
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    CawProfile.mintAndDeposit{value: msg.value}(clientId, recipient, username, newId, depositAmount, lzDestId, lzTokenAmount, "");
  }

  /// @dev Shared prologue for every mint path: validate the username, take the burn cost
  ///      from msg.sender, register the new tokenId, and return it. `extraCawNeeded` is the
  ///      additional CAW msg.sender must hold + have approved beyond burnAmount (e.g. the
  ///      deposit portion in mintAndDepositFor). Pulling the extra is the caller's job —
  ///      this function only verifies the headroom and burns the burn portion.
  function _burnAndAssignId(string memory username, uint256 extraCawNeeded) internal returns (uint32 newId) {
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");
    uint256 burnAmount = costOfName(username);
    uint256 totalCawNeeded = burnAmount + extraCawNeeded;

    require(CAW.balanceOf(_msgSender()) >= totalCawNeeded, "You do not have enough CAW to make this purchase");
    require(CAW.allowance(_msgSender(), address(this)) >= totalCawNeeded, "You must approve spending of your CAW");
    CAW.transferFrom(_msgSender(), address(0xdEAD000000000000000042069420694206942069), burnAmount);

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
    uint32 cawClientId,
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
      cawClientId, tokenId, cawReceived, lzDestId, lzTokenAmount
    );
  }

  /// @notice New-user onboarding paying purely with ETH. Username availability
  ///         is checked BEFORE the swap so a frontrun-mint reverts without
  ///         spending any ETH on Uniswap.
  function mintAndDepositZap(
    uint32 clientId,
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
      clientId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, ""
    );
  }

  /// @notice mintAndDepositZap bundled with QuickSign session registration.
  ///         Self-mint only — recipient is always msg.sender, matching the
  ///         security stance on `mintAndDepositAndQuickSign`.
  function mintAndDepositAndQuickSignZap(
    uint32 clientId,
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
      clientId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount, sessionExtra
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
