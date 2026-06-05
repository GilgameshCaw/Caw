// solidity/test/zap-test.js
//
// ZAP flow tests: depositZap / mintAndDepositZap / mintAndDepositAndQuickSignZap.
// User pays in ETH; the Minter swaps ETH -> CAW via Uniswap V2 (mocked) and
// forwards to the existing mint/deposit pipeline. Self-mint only — no `*For`
// variants. Username availability is checked BEFORE the swap so a frontrun
// reverts cheaply.

const MintableCaw = artifacts.require("MintableCaw");
const CawProfileURI = artifacts.require("CawProfileURI");
const CawFontDataA = artifacts.require("CawFontDataA");
const CawFontDataB = artifacts.require("CawFontDataB");
const CawNetworkManager = artifacts.require("CawNetworkManager");
const CawProfile = artifacts.require("CawProfile");
const CawProfileL2 = artifacts.require("CawProfileL2");
const CawProfileMinter = artifacts.require("CawProfileMinter");
const CawProfileQuoter = artifacts.require("CawProfileQuoter");
const CawBuyAndBurn = artifacts.require("CawBuyAndBurn");
const MockSwapRouter = artifacts.require("MockSwapRouter");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const { ethers } = require('ethers');

const l1 = 30101;
const l2 = 8453;

async function deployURI() {
  var fontA = await CawFontDataA.new();
  var fontB = await CawFontDataB.new();
  return await CawProfileURI.new(fontA.address, fontB.address);
}

async function futureExpiry(secondsFromNow) {
  var latest = await web3.eth.getBlock('latest');
  return Number(latest.timestamp) + secondsFromNow;
}

// Mock router rate is fixed: 1 ETH = 1,000,000 CAW (1e24 wei).
const RATE_CAW_PER_ETH = 1_000_000n;
function expectedCawOut(ethWei) {
  return (BigInt(ethWei) * RATE_CAW_PER_ETH * 10n**18n) / (10n**18n);
}

contract("CawProfileMinter — ZAP (pay-with-ETH) flows", function(accounts) {
  var l1Endpoint, l2Endpoint;
  var token, mockRouter, buyAndBurn;
  var networkManager, uriGen;
  var cawProfile, cawProfileL2, cawProfileL2Mainnet;
  var minter, quoter;
  var l2NetworkId, l1NetworkId;

  before(async function() {
    this.timeout(120000);

    l1Endpoint = await MockLayerZeroEndpoint.new(l1);
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);

    token = await MintableCaw.new();
    mockRouter = await MockSwapRouter.new(token.address);
    // Pre-fund the mock router with CAW so it can transfer; the mock instead
    // mints fresh CAW on each swap, so no funding needed — but we mint a
    // sentinel amount on the router address anyway just to mirror reality.
    buyAndBurn = await CawBuyAndBurn.new(token.address, mockRouter.address);
    networkManager = await CawNetworkManager.new(buyAndBurn.address);
    uriGen = await deployURI();

    // L2-storage mirror (cross-chain)
    cawProfileL2 = await CawProfileL2.new(l1, l2Endpoint.address, "0x0000000000000000000000000000000000000000");
    await l1Endpoint.setDestLzEndpoint(cawProfileL2.address, l2Endpoint.address);

    // L1-co-deployed mirror (deployed before nonce snapshot)
    cawProfileL2Mainnet = await CawProfileL2.new(l1, l1Endpoint.address, "0x0000000000000000000000000000000000000000");

    const dummyPathwayExpander = "0x000000000000000000000000000000000000bEEF";
    const cpNonce = await web3.eth.getTransactionCount(accounts[0]);
    const predictedMinter = ethers.getCreateAddress({ from: accounts[0], nonce: cpNonce + 1 });
    cawProfile = await CawProfile.new(
      token.address, uriGen.address, buyAndBurn.address,
      networkManager.address, l1Endpoint.address, l1,
      "0x0000000000000000000000000000000000000000",
      cawProfileL2.address, dummyPathwayExpander, predictedMinter
    );
    minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address, dummyPathwayExpander);
    assert.equal(minter.address.toLowerCase(), predictedMinter.toLowerCase(), "minter address prediction mismatch");
    await buyAndBurn.setCawProfile(cawProfile.address);
    await cawProfileL2.setL1Peer(l1, cawProfile.address, false);
    await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
    await cawProfile.setL2Peer(l2, cawProfileL2.address);

    await cawProfileL2Mainnet.setL1Peer(l1, cawProfile.address, true);
    await cawProfile.setL2Peer(l1, cawProfileL2Mainnet.address);

    // Two networks to exercise both branches (zero fees to keep ETH math clean)
    await networkManager.createNetwork("L2 Network", accounts[0], l2, 0, 0, 0, 0, 0);
    l2NetworkId = 1;
    await networkManager.createNetwork("L1 Network", accounts[0], l1, 0, 0, 0, 0, 0);
    l1NetworkId = 2;
    quoter = await CawProfileQuoter.new(cawProfile.address);
  });

  // ============================================
  // depositZap (existing-holder top-up)
  // ============================================
  describe("depositZap", function() {
    var tokenId;
    var owner;

    before(async function() {
      this.timeout(60000);
      owner = accounts[1];
      // Mint a username via plain mintAndDeposit (CAW path) so we have a
      // tokenId to top up.
      var mintAmount = BigInt(100) * 1_000_000_000n * 10n**18n;
      await token.mint(owner, mintAmount.toString());
      await token.approve(minter.address, mintAmount.toString(), { from: owner });

      var depositAmount = web3.utils.toWei('1000', 'ether');
      var quote = await quoter.mintAndDepositQuote(l2NetworkId, depositAmount, l2, false);
      await minter.mintAndDeposit(
        l2NetworkId, 'zapowner1', depositAmount, l2, 0,
        { from: owner, value: BigInt(quote.nativeFee).toString() }
      );
      tokenId = (await cawProfile.totalSupply()).toNumber();
    });

    it("happy path (LZ): swap returns >= minCawOut, deposit credited", async function() {
      this.timeout(60000);
      var swapEth = web3.utils.toWei('0.05', 'ether');
      var lzQuote = await quoter.depositZapQuote(l2NetworkId, tokenId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;

      var balBefore = BigInt((await cawProfileL2.cawBalanceOf(tokenId)).toString());

      await minter.depositZap(
        l2NetworkId, tokenId, swapEth, minCawOut.toString(), l2, 0,
        { from: owner, value: totalValue.toString() }
      );

      var balAfter = BigInt((await cawProfileL2.cawBalanceOf(tokenId)).toString());
      var delta = balAfter - balBefore;
      // Mock router pays exactly expectedCaw — it should land on the L2 mirror.
      expect(delta.toString()).to.equal(expectedCaw.toString());
    });

    it("happy path (bypassLZ): credits L1-storage L2 mirror", async function() {
      this.timeout(60000);
      // Mint an L1-storage token under l1NetworkId for this account
      var mintAmount = web3.utils.toWei('5000', 'ether');
      var bypassQuote = await quoter.mintAndDepositQuote(l1NetworkId, mintAmount, l1, false);
      await minter.mintAndDeposit(
        l1NetworkId, 'zapowner2', mintAmount, l1, 0,
        { from: owner, value: BigInt(bypassQuote.nativeFee).toString() }
      );
      var bypassTokenId = (await cawProfile.totalSupply()).toNumber();
      var balBefore = BigInt((await cawProfileL2Mainnet.cawBalanceOf(bypassTokenId)).toString());

      var swapEth = web3.utils.toWei('0.02', 'ether');
      var depositLzQuote = await quoter.depositZapQuote(l1NetworkId, bypassTokenId, l1, false);
      var totalValue = BigInt(swapEth) + BigInt(depositLzQuote.nativeFee);
      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;

      await minter.depositZap(
        l1NetworkId, bypassTokenId, swapEth, minCawOut.toString(), l1, 0,
        { from: owner, value: totalValue.toString() }
      );

      var balAfter = BigInt((await cawProfileL2Mainnet.cawBalanceOf(bypassTokenId)).toString());
      expect((balAfter - balBefore).toString()).to.equal(expectedCaw.toString());
    });

    it("reverts when swap output < minCawOut (slippage protection)", async function() {
      this.timeout(60000);
      var swapEth = web3.utils.toWei('0.01', 'ether');
      var lzQuote = await quoter.depositZapQuote(l2NetworkId, tokenId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var expectedCaw = expectedCawOut(swapEth);
      // Demand 2x what the pool can deliver
      var minCawOut = expectedCaw * 200n / 100n;

      try {
        await minter.depositZap(
          l2NetworkId, tokenId, swapEth, minCawOut.toString(), l2, 0,
          { from: owner, value: totalValue.toString() }
        );
        assert.fail("Should have reverted on slippage");
      } catch (err) {
        assert(
          err.message.includes("INSUFFICIENT_OUTPUT_AMOUNT") || err.message.includes("revert"),
          "Expected slippage revert, got: " + err.message
        );
      }
    });

    it("reverts on bad swap amount (> msg.value)", async function() {
      var swapEth = BigInt(web3.utils.toWei('0.05', 'ether'));
      // msg.value < swapEth → must revert
      try {
        await minter.depositZap(
          l2NetworkId, tokenId, swapEth.toString(), '0', l2, 0,
          { from: owner, value: (swapEth - 1n).toString() }
        );
        assert.fail("Should have reverted");
      } catch (err) {
        assert(err.message.includes("Bad swap amount"), "Got: " + err.message);
      }
    });
  });

  // ============================================
  // mintAndDepositZap (new-user onboarding paying ETH)
  // ============================================
  describe("mintAndDepositZap", function() {
    it("happy path (LZ): NFT minted, name burned, remainder deposited", async function() {
      this.timeout(60000);
      var owner = accounts[2];
      // 0.5 ETH -> 500_000 CAW. 8+ char username burns 1M CAW.
      // With 0.5 ETH the user can't cover an 8-char burn (1M > 500K), so we
      // bump the swap to 1.5 ETH -> 1_500_000 CAW, leaving 500K to deposit.
      var swapEth = web3.utils.toWei('1.5', 'ether');
      var lzQuote = await quoter.mintAndDepositZapQuote(l2NetworkId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var username = 'zapnewone'; // 9 chars -> burn 1M CAW
      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;
      // Verify the swap output exceeds the burn cost for this username
      var burnCost = BigInt(1_000_000) * 10n**18n;
      expect(expectedCaw > burnCost).to.be.true;
      var expectedDeposit = expectedCaw - burnCost;

      var deadBefore = BigInt((await token.balanceOf('0xdEAD000000000000000042069420694206942069')).toString());

      await minter.mintAndDepositZap(
        l2NetworkId, username, swapEth, minCawOut.toString(), l2, 0,
        { from: owner, value: totalValue.toString() }
      );

      var newId = (await cawProfile.totalSupply()).toNumber();
      expect(await cawProfile.ownerOf(newId)).to.equal(owner);

      // Burn cost landed on dead address
      var deadAfter = BigInt((await token.balanceOf('0xdEAD000000000000000042069420694206942069')).toString());
      expect((deadAfter - deadBefore).toString()).to.equal(burnCost.toString());

      // Remainder deposited to L2 mirror
      var bal = BigInt((await cawProfileL2.cawBalanceOf(newId)).toString());
      expect(bal.toString()).to.equal(expectedDeposit.toString());
    });

    it("happy path (bypassLZ): mint+deposit on L1-storage mirror", async function() {
      this.timeout(60000);
      var owner = accounts[3];
      var swapEth = web3.utils.toWei('1.5', 'ether'); // 1.5M CAW
      var lzQuote = await quoter.mintAndDepositZapQuote(l1NetworkId, l1, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var username = 'zapnewtwo'; // 9 chars -> 1M CAW burn
      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;
      var burnCost = BigInt(1_000_000) * 10n**18n;
      var expectedDeposit = expectedCaw - burnCost;

      await minter.mintAndDepositZap(
        l1NetworkId, username, swapEth, minCawOut.toString(), l1, 0,
        { from: owner, value: totalValue.toString() }
      );

      var newId = (await cawProfile.totalSupply()).toNumber();
      expect(await cawProfile.ownerOf(newId)).to.equal(owner);
      var bal = BigInt((await cawProfileL2Mainnet.cawBalanceOf(newId)).toString());
      expect(bal.toString()).to.equal(expectedDeposit.toString());
    });

    it("reverts when cawReceived < costOfName", async function() {
      this.timeout(60000);
      var owner = accounts[4];
      // Tiny swap: 0.0001 ETH -> 100 CAW; way below the 1M CAW burn for 8+ char.
      var swapEth = web3.utils.toWei('0.0001', 'ether');
      var lzQuote = await quoter.mintAndDepositZapQuote(l2NetworkId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      try {
        await minter.mintAndDepositZap(
          l2NetworkId, 'zapcheapnow', swapEth, '0', l2, 0,
          { from: owner, value: totalValue.toString() }
        );
        assert.fail("Should have reverted");
      } catch (err) {
        assert(
          err.message.includes("Swap output < burn cost") || err.message.includes("revert"),
          "Got: " + err.message
        );
      }
    });

    it("reverts BEFORE swap on already-taken username (frontrun protection)", async function() {
      this.timeout(60000);
      var attacker = accounts[5];
      var victim = accounts[6];

      // Attacker mints the username first via the plain CAW path. 9-char
      // name -> 1M CAW burn (8+ chars).
      var burnCost = BigInt(1_000_000) * 10n**18n;
      var depositAmt = web3.utils.toWei('1', 'ether');
      var totalCaw = burnCost + BigInt(depositAmt);
      await token.mint(attacker, totalCaw.toString());
      await token.approve(minter.address, totalCaw.toString(), { from: attacker });

      var quote = await quoter.mintAndDepositQuote(l2NetworkId, depositAmt, l2, false);
      await minter.mintAndDeposit(
        l2NetworkId, 'frontrunzz', depositAmt, l2, 0,
        { from: attacker, value: BigInt(quote.nativeFee).toString() }
      );

      // Victim's ZAP should revert WITHOUT spending ETH on the swap. The
      // require() ordering in the contract enforces the username check
      // BEFORE _swapEthForCaw.
      var swapEth = web3.utils.toWei('1.5', 'ether');
      var lzQuote = await quoter.mintAndDepositZapQuote(l2NetworkId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      try {
        await minter.mintAndDepositZap(
          l2NetworkId, 'frontrunzz', swapEth, '0', l2, 0,
          { from: victim, value: totalValue.toString() }
        );
        assert.fail("Should have reverted");
      } catch (err) {
        assert(
          err.message.includes("Username has already been taken"),
          "Expected pre-swap username revert, got: " + err.message
        );
      }

      // Victim's CAW balance unchanged (no swap output landed)
      var victimCawAfter = BigInt((await token.balanceOf(victim)).toString());
      expect(victimCawAfter).to.equal(0n);
    });

    it("reverts on invalid username", async function() {
      this.timeout(60000);
      var owner = accounts[7];
      var swapEth = web3.utils.toWei('0.5', 'ether');
      var lzQuote = await quoter.mintAndDepositZapQuote(l2NetworkId, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      try {
        await minter.mintAndDepositZap(
          l2NetworkId, 'BAD!', swapEth, '0', l2, 0,
          { from: owner, value: totalValue.toString() }
        );
        assert.fail("Should have reverted");
      } catch (err) {
        assert(
          err.message.includes("Username must only consist of"),
          "Got: " + err.message
        );
      }
    });
  });

  // ============================================
  // mintAndDepositAndQuickSignZap (bundled session registration)
  // ============================================
  describe("mintAndDepositAndQuickSignZap", function() {
    it("happy path (LZ): NFT + deposit + L2 session populated", async function() {
      this.timeout(60000);
      var owner = accounts[8];
      var sessionKey = accounts[9];
      var spendLimit = web3.utils.toWei('500000', 'ether');
      var expiry = await futureExpiry(30 * 24 * 60 * 60);

      var swapEth = web3.utils.toWei('1.5', 'ether');
      var lzQuote = await quoter.mintAndDepositAndQuickSignZapQuote(l2NetworkId, sessionKey, l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;
      var burnCost = BigInt(1_000_000) * 10n**18n; // 'zapqsname' = 9 chars
      var expectedDeposit = expectedCaw - burnCost;

      await minter.mintAndDepositAndQuickSignZap(
        l2NetworkId, 'zapqsname', swapEth, minCawOut.toString(),
        sessionKey, expiry, spendLimit, 0, // perActionTipRate
        l2, 0,
        { from: owner, value: totalValue.toString() }
      );

      var newId = (await cawProfile.totalSupply()).toNumber();
      expect(await cawProfile.ownerOf(newId)).to.equal(owner);
      var bal = BigInt((await cawProfileL2.cawBalanceOf(newId)).toString());
      expect(bal.toString()).to.equal(expectedDeposit.toString());

      // Session populated on L2 with 0xBF scope
      var stored = await cawProfileL2.sessions(owner, sessionKey);
      expect(stored.expiry.toString()).to.equal(expiry.toString());
      expect(stored.scopeBitmap.toString()).to.equal('191'); // 0xBF
      expect(stored.spendLimit.toString()).to.equal(spendLimit);
    });

    it("happy path (bypassLZ): NFT + deposit + session on L1-storage mirror", async function() {
      this.timeout(60000);
      var owner = accounts[1]; // reuse — different sessionKey
      var sessionKey = accounts[3];
      var spendLimit = web3.utils.toWei('250000', 'ether');
      var expiry = await futureExpiry(14 * 24 * 60 * 60);

      var swapEth = web3.utils.toWei('1.5', 'ether');
      var lzQuote = await quoter.mintAndDepositAndQuickSignZapQuote(l1NetworkId, sessionKey, l1, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      var expectedCaw = expectedCawOut(swapEth);
      var minCawOut = expectedCaw * 97n / 100n;
      var burnCost = BigInt(1_000_000) * 10n**18n; // 9-char name
      var expectedDeposit = expectedCaw - burnCost;

      await minter.mintAndDepositAndQuickSignZap(
        l1NetworkId, 'zapqstwoa', swapEth, minCawOut.toString(),
        sessionKey, expiry, spendLimit, 0, // perActionTipRate
        l1, 0,
        { from: owner, value: totalValue.toString() }
      );

      var newId = (await cawProfile.totalSupply()).toNumber();
      expect(await cawProfile.ownerOf(newId)).to.equal(owner);
      var bal = BigInt((await cawProfileL2Mainnet.cawBalanceOf(newId)).toString());
      expect(bal.toString()).to.equal(expectedDeposit.toString());

      var stored = await cawProfileL2Mainnet.sessions(owner, sessionKey);
      expect(stored.expiry.toString()).to.equal(expiry.toString());
      expect(stored.scopeBitmap.toString()).to.equal('191');
      expect(stored.spendLimit.toString()).to.equal(spendLimit);
    });

    it("reverts on zero session key", async function() {
      this.timeout(60000);
      var owner = accounts[2];
      var swapEth = web3.utils.toWei('0.5', 'ether');
      var lzQuote = await quoter.mintAndDepositAndQuickSignZapQuote(l2NetworkId, accounts[1], l2, false);
      var totalValue = BigInt(swapEth) + BigInt(lzQuote.nativeFee);

      try {
        await minter.mintAndDepositAndQuickSignZap(
          l2NetworkId, 'zapqs3', swapEth, '0',
          '0x0000000000000000000000000000000000000000', 0, 0, 0, // perActionTipRate
          l2, 0,
          { from: owner, value: totalValue.toString() }
        );
        assert.fail("Should have reverted");
      } catch (err) {
        assert(err.message.includes("Zero session key"), "Got: " + err.message);
      }
    });
  });
});
