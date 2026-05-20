const CawProfile = artifacts.require("CawProfile");
const CawProfileMinter = artifacts.require("CawProfileMinter");
const CawProfileURI = artifacts.require("CawProfileURI");
const CawNetworkManager = artifacts.require("CawNetworkManager");
const CawProfileMarketplace = artifacts.require("CawProfileMarketplace");
const MintableCaw = artifacts.require("MintableCaw");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const MockSwapRouter = artifacts.require("MockSwapRouter");
const RevertingBidder = artifacts.require("RevertingBidder");

const truffleAssert = require('truffle-assertions');
const { BN, expectRevert, time } = require('@openzeppelin/test-helpers');

contract("CawProfileMarketplace", (accounts) => {
  const deployer = accounts[0];
  const seller = accounts[1];
  const buyer = accounts[2];
  const bidder1 = accounts[3];
  const bidder2 = accounts[4];

  let token, cawProfiles, minter, uriGenerator, networkManager, marketplace, lzEndpoint;
  let tokenId1, tokenId2;

  // Deploy a simple ERC20 for testing ERC20 payment
  let paymentToken;

  before(async () => {
    // Deploy dependencies
    const l1Eid = 30101;
    lzEndpoint = await MockLayerZeroEndpoint.new(l1Eid);
    token = await MintableCaw.new();
    const fontA = await (artifacts.require("CawFontDataA")).new();
    const fontB = await (artifacts.require("CawFontDataB")).new();
    uriGenerator = await CawProfileURI.new(fontA.address, fontB.address);
    networkManager = await CawNetworkManager.new(deployer);

    cawProfiles = await CawProfile.new(
      token.address,
      uriGenerator.address,
      deployer,
      networkManager.address,
      lzEndpoint.address,
      l1Eid,
      "0x0000000000000000000000000000000000000000"
    );

    const mockRouter = await MockSwapRouter.new(token.address);
    minter = await CawProfileMinter.new(
      token.address,
      cawProfiles.address,
      mockRouter.address
    );

    await cawProfiles.setMinter(minter.address);

    // Set up a dummy L2 peer (needed for mint to not revert on peerWithMaxPendingTransfers)
    const dummyL2Eid = 40245;
    await cawProfiles.setL2Peer(dummyL2Eid, accounts[9]); // dummy peer address

    // Create a network (needed for minting)
    await networkManager.createNetwork("Test Network", deployer, dummyL2Eid, 0, 0, 0, 0, 0);

    // Use MintableCaw as payment token for ERC20 tests
    paymentToken = token;

    // Deploy marketplace with the payment-token allowlist baked in.
    // The marketplace has no admin — allowed tokens are fixed at construction.
    marketplace = await CawProfileMarketplace.new(cawProfiles.address, [paymentToken.address]);

    // Mint CAW tokens for users
    const mintAmount = web3.utils.toWei("1000000000000", "ether"); // 1T CAW
    await token.mint(seller, mintAmount);
    await token.mint(buyer, mintAmount);
    await token.mint(bidder1, mintAmount);
    await token.mint(bidder2, mintAmount);

    // Seller approves minter to burn CAW
    await token.approve(minter.address, mintAmount, { from: seller });

    // Mint two CawProfile NFTs for seller (networkId=1, lzTokenAmount=0)
    tokenId1 = (await cawProfiles.nextId()).toNumber();
    await minter.mint(1, "alice", 0, { from: seller, value: web3.utils.toWei("0.01", "ether") });

    tokenId2 = (await cawProfiles.nextId()).toNumber();
    await minter.mint(1, "bob", 0, { from: seller, value: web3.utils.toWei("0.01", "ether") });
  });

  describe("Fixed Price Listing", () => {
    it("should create a fixed price listing with ETH", async () => {
      // Approve marketplace
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });

      const price = web3.utils.toWei("1", "ether");
      const tx = await marketplace.createListing(
        tokenId1,
        0, // FIXED
        "0x0000000000000000000000000000000000000000", // ETH
        price,
        0,
        86400, // 1 day
        { from: seller }
      );

      truffleAssert.eventEmitted(tx, 'Listed', (ev) => {
        return ev.listingId.toString() === "1" &&
               ev.tokenId.toString() === String(tokenId1) &&
               ev.seller === seller;
      });

      const listing = await marketplace.listings(1);
      assert.equal(listing.active, true);
      assert.equal(listing.seller, seller);
      assert.equal(listing.startPrice.toString(), price);
    });

    it("should not allow duplicate listing for same token", async () => {
      await expectRevert(
        marketplace.createListing(
          tokenId1, 0, "0x0000000000000000000000000000000000000000",
          web3.utils.toWei("2", "ether"), 0, 86400, { from: seller }
        ),
        "Token already listed"
      );
    });

    it("should buy fixed price listing with ETH", async () => {
      const price = web3.utils.toWei("1", "ether");
      const sellerBalBefore = BigInt(await web3.eth.getBalance(seller));

      const tx = await marketplace.buy(1, { from: buyer, value: price });

      truffleAssert.eventEmitted(tx, 'Sale', (ev) => {
        return ev.buyer === buyer && ev.price.toString() === price;
      });

      // Verify NFT transferred
      const newOwner = await cawProfiles.ownerOf(tokenId1);
      assert.equal(newOwner, buyer);

      // Verify listing is no longer active
      const listing = await marketplace.listings(1);
      assert.equal(listing.active, false);

      // H-15: seller payment is queued in pendingPayouts (pull pattern), not pushed.
      // Balance unchanged until seller calls withdrawPayouts().
      const sellerBalAfter = BigInt(await web3.eth.getBalance(seller));
      assert.equal(sellerBalAfter.toString(), sellerBalBefore.toString(),
        "H-15: seller balance must not change on buy (payment queued in pendingPayouts)");
      const queued = BigInt((await marketplace.pendingPayouts(seller)).toString());
      assert(queued >= BigInt(price), "H-15: price must be in pendingPayouts");

      // Seller withdraws; verify payment lands.
      await marketplace.withdrawPayouts({ from: seller });
      const sellerBalFinal = BigInt(await web3.eth.getBalance(seller));
      assert(sellerBalFinal > sellerBalBefore, "H-15: seller should receive ETH after withdrawPayouts");
    });

    it("should forward excess ETH as LZ fee for L2 sync", async () => {
      // Transfer token back to seller for more tests
      await cawProfiles.transferFrom(buyer, seller, tokenId1, { from: buyer });

      const price = web3.utils.toWei("0.5", "ether");
      await marketplace.createListing(
        tokenId1, 0, "0x0000000000000000000000000000000000000000",
        price, 0, 86400, { from: seller }
      );

      const listingId = (await marketplace.nextListingId()).toNumber() - 1;
      // Send price + a small LZ fee
      const totalValue = web3.utils.toWei("0.51", "ether");

      await marketplace.buy(listingId, { from: buyer, value: totalValue });

      // Verify NFT transferred
      assert.equal(await cawProfiles.ownerOf(tokenId1), buyer);
    });

    it("should create and buy fixed price listing with ERC20", async () => {
      // Transfer back for this test
      await cawProfiles.transferFrom(buyer, seller, tokenId1, { from: buyer });

      const price = web3.utils.toWei("1000", "ether");
      await marketplace.createListing(
        tokenId1, 0, paymentToken.address,
        price, 0, 86400, { from: seller }
      );
      const listingId = (await marketplace.nextListingId()).toNumber() - 1;

      // Buyer approves marketplace to spend payment token
      await paymentToken.approve(marketplace.address, price, { from: buyer });

      const sellerBalBefore = BigInt((await paymentToken.balanceOf(seller)).toString());
      await marketplace.buyWithToken(listingId, price, { from: buyer });
      const sellerBalAfter = BigInt((await paymentToken.balanceOf(seller)).toString());

      assert.equal((await cawProfiles.ownerOf(tokenId1)), buyer);
      assert(sellerBalAfter > sellerBalBefore, "Seller should receive ERC20");
    });
  });

  describe("Dutch Auction", () => {
    let dutchListingId;

    before(async () => {
      // Transfer back
      await cawProfiles.transferFrom(buyer, seller, tokenId1, { from: buyer });
    });

    it("should create a Dutch auction listing", async () => {
      const startPrice = web3.utils.toWei("2", "ether");
      const endPrice = web3.utils.toWei("0.5", "ether");
      const duration = 3600; // 1 hour

      const tx = await marketplace.createListing(
        tokenId1, 1, // DUTCH_AUCTION
        "0x0000000000000000000000000000000000000000",
        startPrice, endPrice, duration,
        { from: seller }
      );

      dutchListingId = (await marketplace.nextListingId()).toNumber() - 1;

      truffleAssert.eventEmitted(tx, 'Listed', (ev) => {
        return ev.listingType.toString() === "1"; // DUTCH_AUCTION
      });
    });

    it("should return start price at the beginning", async () => {
      const price = await marketplace.getCurrentPrice(dutchListingId);
      assert.equal(price.toString(), web3.utils.toWei("2", "ether"));
    });

    it("should decrease price over time", async () => {
      // Advance time by 30 minutes (half the duration)
      await time.increase(1800);

      const price = await marketplace.getCurrentPrice(dutchListingId);
      const priceNum = parseFloat(web3.utils.fromWei(price.toString(), "ether"));

      // At halfway, price should be ~1.25 ETH (midpoint between 2 and 0.5)
      assert(priceNum > 1.0 && priceNum < 1.6, `Price should be around 1.25, got ${priceNum}`);
    });

    it("should allow buying at current Dutch price", async () => {
      const price = await marketplace.getCurrentPrice(dutchListingId);
      // Send a bit more to account for time passing during tx
      const overpay = BigInt(price.toString()) + BigInt(web3.utils.toWei("0.1", "ether"));

      await marketplace.buy(dutchListingId, { from: buyer, value: overpay.toString() });

      assert.equal(await cawProfiles.ownerOf(tokenId1), buyer);
    });

    it("should return endPrice after duration expires", async () => {
      // Transfer back and create new Dutch auction
      await cawProfiles.transferFrom(buyer, seller, tokenId1, { from: buyer });

      const startPrice = web3.utils.toWei("1", "ether");
      const endPrice = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        tokenId1, 1, "0x0000000000000000000000000000000000000000",
        startPrice, endPrice, 60, // 1 minute
        { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      // Advance past the end
      await time.increase(120);

      const price = await marketplace.getCurrentPrice(lid);
      assert.equal(price.toString(), endPrice, "Should return floor price after expiry");

      // Buy at floor price
      await marketplace.buy(lid, { from: buyer, value: endPrice });
      assert.equal(await cawProfiles.ownerOf(tokenId1), buyer);
    });
  });

  describe("English Auction", () => {
    let auctionListingId;

    before(async () => {
      // Transfer back
      await cawProfiles.transferFrom(buyer, seller, tokenId1, { from: buyer });
    });

    it("should create an English auction listing", async () => {
      const minBid = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        tokenId1, 2, // ENGLISH_AUCTION
        "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, // 1 hour
        { from: seller }
      );

      auctionListingId = (await marketplace.nextListingId()).toNumber() - 1;
    });

    it("should accept first bid at or above start price", async () => {
      const bid = web3.utils.toWei("0.1", "ether");
      const tx = await marketplace.placeBid(auctionListingId, { from: bidder1, value: bid });

      truffleAssert.eventEmitted(tx, 'BidPlaced', (ev) => {
        return ev.bidder === bidder1 && ev.amount.toString() === bid;
      });
    });

    it("should reject bid below minimum increment", async () => {
      // 5% of 0.1 = 0.005, so min next bid = 0.105
      const lowBid = web3.utils.toWei("0.104", "ether");
      await expectRevert(
        marketplace.placeBid(auctionListingId, { from: bidder2, value: lowBid }),
        "Bid too low"
      );
    });

    it("should accept higher bid and push refund to outbid EOA", async () => {
      // Hybrid refund: EOA bidders are pushed (2300-gas stipend is enough);
      // contract bidders that revert in receive() get credited to
      // pendingReturns instead. bidder1 is a Truffle EOA, so it should
      // receive the refund directly and pendingReturns should stay zero.
      const bid = web3.utils.toWei("0.2", "ether");
      const balBefore = BigInt(await web3.eth.getBalance(bidder1));
      await marketplace.placeBid(auctionListingId, { from: bidder2, value: bid });
      const balAfter = BigInt(await web3.eth.getBalance(bidder1));

      // Refund pushed: bidder1's balance went up by the prior bid.
      assert.equal(
        (balAfter - balBefore).toString(),
        web3.utils.toWei("0.1", "ether"),
        "Outbid EOA should receive refund via push"
      );

      // pendingReturns should NOT have been credited (push succeeded).
      const pending = await marketplace.pendingReturns(bidder1, auctionListingId);
      assert.equal(pending.toString(), "0", "pendingReturns should be empty for EOA");
    });

    it("should extend deadline on anti-snipe bid", async () => {
      const listing = await marketplace.listings(auctionListingId);
      const endTimeBefore = BigInt(listing.endTime.toString());

      // Advance to within 10 minutes of end
      const now = BigInt((await time.latest()).toString());
      const timeUntilEnd = endTimeBefore - now;
      if (timeUntilEnd > 600n) {
        await time.increase(Number(timeUntilEnd - 300n)); // 5 minutes before end
      }

      const bid = web3.utils.toWei("0.3", "ether");
      await marketplace.placeBid(auctionListingId, { from: bidder1, value: bid });

      const updatedListing = await marketplace.listings(auctionListingId);
      const endTimeAfter = BigInt(updatedListing.endTime.toString());
      assert(endTimeAfter > endTimeBefore, "End time should be extended");
    });

    it("should not allow settling before auction ends", async () => {
      await expectRevert(
        marketplace.settleAuction(auctionListingId),
        "Auction not ended"
      );
    });

    // Cancel-with-bids semantics tested in the Cancellation describe block below
    // (requires a fresh token to avoid breaking the settle-after-deadline test
    // sequence in this block).

    it("should settle auction after deadline", async () => {
      // Advance past end
      await time.increase(700);

      const sellerBalBefore = BigInt(await web3.eth.getBalance(seller));
      const tx = await marketplace.settleAuction(auctionListingId, { from: accounts[5] }); // anyone can settle

      truffleAssert.eventEmitted(tx, 'AuctionSettled');

      // NFT goes to highest bidder (bidder1 with 0.3 ETH)
      assert.equal(await cawProfiles.ownerOf(tokenId1), bidder1);

      // H-15: seller payment is queued in pendingPayouts (pull pattern).
      const sellerBalAfter = BigInt(await web3.eth.getBalance(seller));
      assert.equal(sellerBalAfter.toString(), sellerBalBefore.toString(),
        "H-15: seller balance must not change on settleAuction (payment queued in pendingPayouts)");
      const queued = BigInt((await marketplace.pendingPayouts(seller)).toString());
      assert(queued > 0n, "H-15: winning bid must be in pendingPayouts");

      // Seller withdraws.
      await marketplace.withdrawPayouts({ from: seller });
      const sellerBalFinal = BigInt(await web3.eth.getBalance(seller));
      assert(sellerBalFinal > sellerBalBefore, "H-15: seller should receive ETH after withdrawPayouts");
    });
  });

  describe("English Auction — push-with-pull refund fallback", () => {
    // Hybrid refund: placeBid attempts a 2300-gas push to the prior high
    // bidder and falls back to pendingReturns on failure. EOAs always succeed
    // (covered above). This block covers the contract-bidder fallback —
    // RevertingBidder reverts in receive(), so the push fails and the
    // pendingReturns mapping must hold the credit instead. Critically, the
    // outbid tx itself must still succeed (otherwise a malicious contract
    // bidder could grief the auction by blocking all subsequent bids).

    it("credits pendingReturns when refund push reverts; outbid still succeeds", async () => {
      // Fresh token to keep this block independent of the stateful sequence above.
      const freshTokenId = (await cawProfiles.nextId()).toNumber();
      await minter.mint(1, "carol", 0, { from: seller, value: web3.utils.toWei("0.01", "ether") });

      const minBid = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        freshTokenId, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      // Deploy a contract bidder that reverts on receive().
      const revertingBidder = await RevertingBidder.new(marketplace.address);

      // Fund + place the first bid via the contract.
      const firstBid = web3.utils.toWei("0.1", "ether");
      await revertingBidder.placeBid(lid, { from: bidder1, value: firstBid });

      // Sanity: contract is the highest bidder.
      let listing = await marketplace.listings(lid);
      assert.equal(listing.highestBidder, revertingBidder.address);
      assert.equal(listing.highestBid.toString(), firstBid);
      // pendingReturns empty so far — no outbid yet.
      let pending = await marketplace.pendingReturns(revertingBidder.address, lid);
      assert.equal(pending.toString(), "0");

      // Outbid by an EOA. The push to revertingBidder.receive() will fail;
      // the contract should fall back to crediting pendingReturns. The
      // outbid tx itself must still succeed.
      const secondBid = web3.utils.toWei("0.2", "ether");
      const tx = await marketplace.placeBid(lid, { from: bidder2, value: secondBid });
      truffleAssert.eventEmitted(tx, 'BidPlaced', (ev) => {
        return ev.bidder === bidder2 && ev.amount.toString() === secondBid;
      });

      // The reverting bidder is credited via the pull path.
      pending = await marketplace.pendingReturns(revertingBidder.address, lid);
      assert.equal(pending.toString(), firstBid, "Reverting bidder should be credited via pendingReturns");

      // New high bidder is set correctly.
      listing = await marketplace.listings(lid);
      assert.equal(listing.highestBidder, bidder2);
      assert.equal(listing.highestBid.toString(), secondBid);

      // Clean up so the freshTokenId/listing don't bleed into later tests.
      await marketplace.cancelListing(lid, { from: seller });
    });
  });

  describe("Cancellation", () => {
    it("should allow cancelling a fixed listing", async () => {
      // bidder1 now owns tokenId1, let's use tokenId2 (still owned by seller)
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });

      const price = web3.utils.toWei("1", "ether");
      await marketplace.createListing(
        tokenId2, 0, "0x0000000000000000000000000000000000000000",
        price, 0, 86400, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      const tx = await marketplace.cancelListing(lid, { from: seller });
      truffleAssert.eventEmitted(tx, 'ListingCancelled');

      const listing = await marketplace.listings(lid);
      assert.equal(listing.active, false);
    });

    it("should allow cancelling English auction with no bids", async () => {
      const minBid = web3.utils.toWei("0.5", "ether");
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      const tx = await marketplace.cancelListing(lid, { from: seller });
      truffleAssert.eventEmitted(tx, 'ListingCancelled');
    });

    it("should allow cancelling English auction WITH bids; bidder is credited via pendingReturns", async () => {
      // Create a fresh auction on tokenId2, place a bid, then have the seller cancel.
      // Listing must become inactive and the bidder's bid must show up in
      // pendingReturns (pull-pattern refund, see CawProfileMarketplace:cancelListing).
      // We use pull instead of push so a malicious bidder contract whose receive()
      // reverts can't block the seller from cancelling.
      const minBid = web3.utils.toWei("0.5", "ether");
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      const bidAmount = web3.utils.toWei("0.6", "ether");
      await marketplace.placeBid(lid, { from: bidder1, value: bidAmount });

      const tx = await marketplace.cancelListing(lid, { from: seller });
      truffleAssert.eventEmitted(tx, 'BidReclaimed');
      truffleAssert.eventEmitted(tx, 'ListingCancelled');

      // Bid was pull-credited (not pushed) — pendingReturns holds it now.
      const credited = await marketplace.pendingReturns(bidder1, lid);
      assert.equal(credited.toString(), BigInt(bidAmount).toString());

      // The bidder withdraws and the funds (minus gas) finally land in their wallet.
      const bidderBalBefore = BigInt(await web3.eth.getBalance(bidder1));
      const wTx = await marketplace.withdrawBid(lid, { from: bidder1 });
      const wReceipt = await web3.eth.getTransactionReceipt(wTx.tx);
      const wTxData = await web3.eth.getTransaction(wTx.tx);
      const gasCost = BigInt(wReceipt.gasUsed) * BigInt(wTxData.gasPrice);
      const bidderBalAfter = BigInt(await web3.eth.getBalance(bidder1));
      assert.equal((bidderBalAfter - bidderBalBefore + gasCost).toString(), BigInt(bidAmount).toString());

      // pendingReturns is now zero
      const remaining = await marketplace.pendingReturns(bidder1, lid);
      assert.equal(remaining.toString(), '0');

      const listing = await marketplace.listings(lid);
      assert.equal(listing.active, false);
    });

    it("should not allow non-seller to cancel", async () => {
      const price = web3.utils.toWei("1", "ether");
      await marketplace.createListing(
        tokenId2, 0, "0x0000000000000000000000000000000000000000",
        price, 0, 86400, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      await expectRevert(
        marketplace.cancelListing(lid, { from: buyer }),
        "Not seller"
      );

      // Clean up
      await marketplace.cancelListing(lid, { from: seller });
    });
  });

  describe("Edge Cases", () => {
    it("should fail if marketplace not approved", async () => {
      // Revoke approval
      await cawProfiles.setApprovalForAll(marketplace.address, false, { from: seller });

      await expectRevert(
        marketplace.createListing(
          tokenId2, 0, "0x0000000000000000000000000000000000000000",
          web3.utils.toWei("1", "ether"), 0, 86400, { from: seller }
        ),
        "Marketplace not approved"
      );

      // Restore approval
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });
    });

    it("should fail if non-owner tries to list", async () => {
      await expectRevert(
        marketplace.createListing(
          tokenId2, 0, "0x0000000000000000000000000000000000000000",
          web3.utils.toWei("1", "ether"), 0, 86400, { from: buyer }
        ),
        "Not token owner"
      );
    });

    it("should fail buy if seller transferred NFT after listing", async () => {
      // List tokenId2
      await marketplace.createListing(
        tokenId2, 0, "0x0000000000000000000000000000000000000000",
        web3.utils.toWei("0.1", "ether"), 0, 86400, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      // Seller transfers NFT away (breaking the listing)
      await cawProfiles.transferFrom(seller, accounts[6], tokenId2, { from: seller });

      // Buy should fail because seller no longer owns the token
      await expectRevert.unspecified(
        marketplace.buy(lid, { from: buyer, value: web3.utils.toWei("0.1", "ether") })
      );

      // Transfer back for cleanup
      await cawProfiles.transferFrom(accounts[6], seller, tokenId2, { from: accounts[6] });

      // Cancel the broken listing
      await marketplace.cancelListing(lid, { from: seller });
    });

    it("should reject unapproved payment token", async () => {
      const fakeToken = accounts[8]; // random address as fake token
      await expectRevert(
        marketplace.createListing(
          tokenId2, 0, fakeToken,
          web3.utils.toWei("1", "ether"), 0, 86400, { from: seller }
        ),
        "Payment token not allowed"
      );
    });

    it("should reject Dutch auction with invalid prices", async () => {
      await expectRevert(
        marketplace.createListing(
          tokenId2, 1, "0x0000000000000000000000000000000000000000",
          web3.utils.toWei("1", "ether"),
          web3.utils.toWei("2", "ether"), // endPrice > startPrice
          3600, { from: seller }
        ),
        "Invalid Dutch auction prices"
      );
    });

    it("should reject English auction buy attempt", async () => {
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        web3.utils.toWei("0.1", "ether"), 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      await expectRevert(
        marketplace.buy(lid, { from: buyer, value: web3.utils.toWei("0.1", "ether") }),
        "Use placeBid for auctions"
      );

      // Cancel for cleanup
      await marketplace.cancelListing(lid, { from: seller });
    });

    it("should handle expired auction with no bids", async () => {
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        web3.utils.toWei("1", "ether"), 0, 60, // 1 minute
        { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      await time.increase(120);

      // settleAuction should fail with no bids
      await expectRevert(
        marketplace.settleAuction(lid),
        "No bids"
      );

      // Seller can still cancel
      await marketplace.cancelListing(lid, { from: seller });
    });
  });

  describe("Reclaim Bid (transferred NFT safety valve)", () => {
    let reclaimAuctionId;

    before(async () => {
      // Ensure seller owns tokenId2 and marketplace is approved
      assert.equal(await cawProfiles.ownerOf(tokenId2), seller);
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });
    });

    it("should allow reclaiming bid when seller transfers NFT away", async () => {
      // Create English auction
      const minBid = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      reclaimAuctionId = (await marketplace.nextListingId()).toNumber() - 1;

      // Bidder places a bid (ETH is escrowed)
      const bid = web3.utils.toWei("0.5", "ether");
      await marketplace.placeBid(reclaimAuctionId, { from: bidder1, value: bid });

      // Seller transfers NFT to someone else
      await cawProfiles.transferFrom(seller, accounts[7], tokenId2, { from: seller });

      // Advance past auction end
      await time.increase(3700);

      // settleAuction should revert (seller doesn't own NFT)
      await expectRevert.unspecified(
        marketplace.settleAuction(reclaimAuctionId)
      );

      // Bidder reclaims their bid (pull pattern — credits pendingReturns).
      const tx = await marketplace.reclaimBid(reclaimAuctionId, { from: bidder1 });
      truffleAssert.eventEmitted(tx, 'BidReclaimed', (ev) => {
        return ev.bidder === bidder1 && ev.amount.toString() === bid;
      });

      const credited = await marketplace.pendingReturns(bidder1, reclaimAuctionId);
      assert.equal(credited.toString(), bid, "Bidder should be credited via pendingReturns");

      // Bidder withdraws — funds (minus gas) finally land in their wallet.
      const balBefore = BigInt(await web3.eth.getBalance(bidder1));
      const wTx = await marketplace.withdrawBid(reclaimAuctionId, { from: bidder1 });
      const wReceipt = await web3.eth.getTransactionReceipt(wTx.tx);
      const wTxData = await web3.eth.getTransaction(wTx.tx);
      const gasCost = BigInt(wReceipt.gasUsed) * BigInt(wTxData.gasPrice);
      const balAfter = BigInt(await web3.eth.getBalance(bidder1));
      assert.equal((balAfter - balBefore + gasCost).toString(), bid);

      // Listing should be inactive
      const listing = await marketplace.listings(reclaimAuctionId);
      assert.equal(listing.active, false);

      // Transfer back for other tests
      await cawProfiles.transferFrom(accounts[7], seller, tokenId2, { from: accounts[7] });
    });

    it("should not allow reclaim when seller still owns NFT", async () => {
      const minBid = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      await marketplace.placeBid(lid, { from: bidder1, value: web3.utils.toWei("0.1", "ether") });

      await expectRevert(
        marketplace.reclaimBid(lid, { from: bidder1 }),
        "Seller still owns NFT"
      );

      // Advance past auction end and settle normally
      await time.increase(3700);
      await marketplace.settleAuction(lid);

      // Transfer back
      await cawProfiles.transferFrom(bidder1, seller, tokenId2, { from: bidder1 });
    });

    it("should allow anyone to call reclaimBid (not just bidder)", async () => {
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });

      const minBid = web3.utils.toWei("0.1", "ether");
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      await marketplace.placeBid(lid, { from: bidder2, value: web3.utils.toWei("0.2", "ether") });

      // Transfer NFT away
      await cawProfiles.transferFrom(seller, accounts[7], tokenId2, { from: seller });

      // Anyone (accounts[5]) can call reclaimBid; bid is credited to the original
      // bidder via pendingReturns regardless of who called.
      const bid = web3.utils.toWei("0.2", "ether");
      await marketplace.reclaimBid(lid, { from: accounts[5] });
      const credited = await marketplace.pendingReturns(bidder2, lid);
      assert.equal(credited.toString(), bid, "Bidder should be credited even when third party reclaimed");

      // Transfer back
      await cawProfiles.transferFrom(accounts[7], seller, tokenId2, { from: accounts[7] });
    });

    it("should allow reclaiming ERC20 bid when seller transfers NFT", async () => {
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });

      const minBid = web3.utils.toWei("100", "ether");
      await marketplace.createListing(
        tokenId2, 2, paymentToken.address,
        minBid, 0, 3600, { from: seller }
      );
      const lid = (await marketplace.nextListingId()).toNumber() - 1;

      // Bidder approves and bids
      await paymentToken.approve(marketplace.address, minBid, { from: bidder1 });
      await marketplace.placeBidWithToken(lid, minBid, { from: bidder1 });

      // Seller transfers away
      await cawProfiles.transferFrom(seller, accounts[7], tokenId2, { from: seller });

      // Reclaim — credits pendingReturns (pull pattern, same as ETH path).
      await marketplace.reclaimBid(lid, { from: bidder1 });
      const credited = await marketplace.pendingReturns(bidder1, lid);
      assert.equal(credited.toString(), minBid, "Bidder should be credited ERC20 amount via pendingReturns");

      // Withdraw to actually move the tokens.
      const bidderBalBefore = BigInt((await paymentToken.balanceOf(bidder1)).toString());
      await marketplace.withdrawBid(lid, { from: bidder1 });
      const bidderBalAfter = BigInt((await paymentToken.balanceOf(bidder1)).toString());
      assert.equal((bidderBalAfter - bidderBalBefore).toString(), minBid, "Bidder should receive ERC20 refund");

      // Transfer back
      await cawProfiles.transferFrom(accounts[7], seller, tokenId2, { from: accounts[7] });
    });
  });

  describe("Buy Offers", () => {
    before(async () => {
      // Ensure seller owns tokenId2
      assert.equal(await cawProfiles.ownerOf(tokenId2), seller);
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });
    });

    it("should create an ETH offer", async () => {
      const amount = web3.utils.toWei("0.5", "ether");
      const tx = await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: amount });

      truffleAssert.eventEmitted(tx, 'OfferCreated', (ev) => {
        return ev.tokenId.toString() === String(tokenId2) &&
               ev.offerer === buyer &&
               ev.amount.toString() === amount;
      });

      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;
      const offer = await marketplace.offers(offerId);
      assert.equal(offer.active, true);
      assert.equal(offer.offerer, buyer);
      assert.equal(offer.amount.toString(), amount);
    });

    it("should allow seller to accept ETH offer", async () => {
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      const sellerBalBefore = BigInt(await web3.eth.getBalance(seller));
      const tx = await marketplace.acceptOffer(offerId, { from: seller });

      truffleAssert.eventEmitted(tx, 'OfferAccepted', (ev) => {
        return ev.seller === seller && ev.buyer === buyer;
      });

      // NFT transferred to buyer
      assert.equal(await cawProfiles.ownerOf(tokenId2), buyer);

      // H-15: seller payment is queued in pendingPayouts (pull pattern).
      const sellerBalAfter = BigInt(await web3.eth.getBalance(seller));
      assert.equal(sellerBalAfter.toString(), sellerBalBefore.toString(),
        "H-15: seller balance must not change on acceptOffer (payment queued in pendingPayouts)");
      const queued = BigInt((await marketplace.pendingPayouts(seller)).toString());
      assert(queued > 0n, "H-15: offer amount must be in pendingPayouts");

      // Seller withdraws.
      await marketplace.withdrawPayouts({ from: seller });
      const sellerBalFinal = BigInt(await web3.eth.getBalance(seller));
      assert(sellerBalFinal > sellerBalBefore, "H-15: seller should receive ETH after withdrawPayouts");

      // Offer is no longer active
      const offer = await marketplace.offers(offerId);
      assert.equal(offer.active, false);

      // Transfer back
      await cawProfiles.transferFrom(buyer, seller, tokenId2, { from: buyer });
    });

    it("should create and accept an ERC20 offer", async () => {
      const amount = web3.utils.toWei("5000", "ether");

      // Buyer approves marketplace for ERC20
      await paymentToken.approve(marketplace.address, amount, { from: buyer });

      const tx = await marketplace.createOfferERC20(tokenId2, paymentToken.address, amount, 86400, { from: buyer });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      truffleAssert.eventEmitted(tx, 'OfferCreated');

      const sellerBalBefore = BigInt((await paymentToken.balanceOf(seller)).toString());
      await marketplace.acceptOffer(offerId, { from: seller });
      const sellerBalAfter = BigInt((await paymentToken.balanceOf(seller)).toString());

      assert.equal(await cawProfiles.ownerOf(tokenId2), buyer);
      assert(sellerBalAfter > sellerBalBefore, "Seller should receive ERC20");

      // Transfer back
      await cawProfiles.transferFrom(buyer, seller, tokenId2, { from: buyer });
    });

    it("should allow offerer to cancel and reclaim funds", async () => {
      const amount = web3.utils.toWei("1", "ether");
      await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: amount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      const balBefore = BigInt(await web3.eth.getBalance(buyer));
      const tx = await marketplace.cancelOffer(offerId, { from: buyer });
      const balAfter = BigInt(await web3.eth.getBalance(buyer));

      truffleAssert.eventEmitted(tx, 'OfferCancelled');
      assert(balAfter > balBefore, "Buyer should get refund");

      const offer = await marketplace.offers(offerId);
      assert.equal(offer.active, false);
    });

    it("should not allow non-offerer to cancel before expiry", async () => {
      const amount = web3.utils.toWei("1", "ether");
      await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: amount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      await expectRevert(
        marketplace.cancelOffer(offerId, { from: accounts[6] }),
        "Only offerer can cancel before expiry"
      );

      // Cleanup
      await marketplace.cancelOffer(offerId, { from: buyer });
    });

    it("should allow anyone to cancel after expiry", async () => {
      const amount = web3.utils.toWei("0.1", "ether");
      await marketplace.createOfferETH(tokenId2, 60, { from: buyer, value: amount }); // 1 min expiry
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      await time.increase(120); // Past expiry

      const buyerBalBefore = BigInt(await web3.eth.getBalance(buyer));
      await marketplace.cancelOffer(offerId, { from: accounts[6] }); // third party cancels
      const buyerBalAfter = BigInt(await web3.eth.getBalance(buyer));

      assert(buyerBalAfter > buyerBalBefore, "Offerer should get refund even when cancelled by third party");
    });

    it("should reject accepting expired offer", async () => {
      const amount = web3.utils.toWei("0.1", "ether");
      await marketplace.createOfferETH(tokenId2, 60, { from: buyer, value: amount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      await time.increase(120);

      await expectRevert(
        marketplace.acceptOffer(offerId, { from: seller }),
        "Offer expired"
      );

      // Cleanup
      await marketplace.cancelOffer(offerId, { from: buyer });
    });

    it("should reject accepting offer if not token owner", async () => {
      const amount = web3.utils.toWei("0.5", "ether");
      await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: amount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      await expectRevert(
        marketplace.acceptOffer(offerId, { from: accounts[6] }),
        "Not token owner"
      );

      // Cleanup
      await marketplace.cancelOffer(offerId, { from: buyer });
    });

    it("should cancel active listing when accepting offer", async () => {
      // Create a fixed listing
      const price = web3.utils.toWei("2", "ether");
      await marketplace.createListing(
        tokenId2, 0, "0x0000000000000000000000000000000000000000",
        price, 0, 86400, { from: seller }
      );
      const listingId = (await marketplace.nextListingId()).toNumber() - 1;

      // Create offer
      const offerAmount = web3.utils.toWei("1.5", "ether");
      await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: offerAmount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      // Accept offer — should also cancel the listing
      const tx = await marketplace.acceptOffer(offerId, { from: seller });

      truffleAssert.eventEmitted(tx, 'ListingCancelled', (ev) => {
        return ev.listingId.toString() === String(listingId);
      });
      truffleAssert.eventEmitted(tx, 'OfferAccepted');

      // Listing should be cancelled
      const listing = await marketplace.listings(listingId);
      assert.equal(listing.active, false);

      // Transfer back
      await cawProfiles.transferFrom(buyer, seller, tokenId2, { from: buyer });
    });

    it("should not allow accepting offer when auction has bids", async () => {
      await cawProfiles.setApprovalForAll(marketplace.address, true, { from: seller });

      // Create English auction with a bid
      await marketplace.createListing(
        tokenId2, 2, "0x0000000000000000000000000000000000000000",
        web3.utils.toWei("0.1", "ether"), 0, 3600, { from: seller }
      );
      const auctionId = (await marketplace.nextListingId()).toNumber() - 1;
      await marketplace.placeBid(auctionId, { from: bidder1, value: web3.utils.toWei("0.1", "ether") });

      // Create offer
      const offerAmount = web3.utils.toWei("1", "ether");
      await marketplace.createOfferETH(tokenId2, 86400, { from: buyer, value: offerAmount });
      const offerId = (await marketplace.nextOfferId()).toNumber() - 1;

      // Accepting should fail because auction has bids
      await expectRevert(
        marketplace.acceptOffer(offerId, { from: seller }),
        "Cannot accept offer while auction has bids"
      );

      // Cleanup: advance time, settle auction, cancel offer
      await time.increase(3700);
      await marketplace.settleAuction(auctionId);
      await marketplace.cancelOffer(offerId, { from: buyer });

      // Transfer back
      await cawProfiles.transferFrom(bidder1, seller, tokenId2, { from: bidder1 });
    });
  });

  describe("Payment-token allowlist (no admin)", () => {
    it("ETH (address(0)) is always allowed", async () => {
      assert.equal(await marketplace.allowedPaymentTokens('0x0000000000000000000000000000000000000000'), true);
    });

    it("constructor-allowed tokens are on the allowlist", async () => {
      assert.equal(await marketplace.allowedPaymentTokens(paymentToken.address), true);
    });

    it("tokens not passed at construction are not allowed", async () => {
      const random = accounts[9];
      assert.equal(await marketplace.allowedPaymentTokens(random), false);
    });

    it("there is no setAllowedPaymentToken function (no admin)", async () => {
      assert.equal(typeof marketplace.setAllowedPaymentToken, 'undefined');
    });

    it("can deploy with no extra tokens (ETH-only marketplace)", async () => {
      const ethOnly = await CawProfileMarketplace.new(cawProfiles.address, []);
      assert.equal(await ethOnly.allowedPaymentTokens('0x0000000000000000000000000000000000000000'), true);
      assert.equal(await ethOnly.allowedPaymentTokens(paymentToken.address), false);
    });
  });
});
