// contracts/CawProfileMarketplace.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface ICawProfileTransfer is IERC721 {
    function transferAndSync(address to, uint256 tokenId, uint32 lzDestId, uint256 lzTokenAmount) external payable;
}

/**
 * @title CawProfileMarketplace
 * @notice Trustless, feeless marketplace for CAW username NFTs.
 *         Supports fixed-price sales, Dutch auctions, English auctions, and buy offers.
 *         0% fees forever, no admin — per the CAW manifesto.
 *
 * @dev No `Ownable` inheritance. The allowed-payment-token set is fixed at
 *      construction (passed by the deployer for the env's WETH/USDC/USDT/CAW
 *      addresses), and ETH (address(0)) is always allowed. There is no
 *      post-deploy way to add or remove a payment token. If the ecosystem
 *      decides a different set is desirable, deploy a sibling marketplace.
 *
 * @dev Audit-trail tags in this contract (e.g. "H-N", "M-N", "Round N",
 *      "Audit fix YYYY-MM-DD") are decoded in `docs/AUDIT_TRAIL.md`.
 */
contract CawProfileMarketplace is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum ListingType { FIXED, DUTCH_AUCTION, ENGLISH_AUCTION }

    struct Listing {
        uint32 tokenId;
        address seller;
        address paymentToken;       // address(0) = ETH
        ListingType listingType;
        uint256 startPrice;         // Fixed: price. Dutch: start price. English: min bid.
        uint256 endPrice;           // Dutch only: floor price. Others: 0.
        uint64 startTime;
        uint64 endTime;             // Dutch: when price hits floor. English: deadline.
        uint256 highestBid;         // English only
        address highestBidder;      // English only
        bool active;
    }

    struct Offer {
        address offerer;
        uint32 tokenId;
        address paymentToken;       // address(0) = ETH
        uint256 amount;
        uint64 expiry;
        bool active;
    }

    ICawProfileTransfer public immutable cawProfile;
    /// @dev LZ eid passed to transferAndSync. Mainnet/bypassLZ eid is the natural
    ///      choice: on bypassLZ deployments it's a no-op (queue stays empty for
    ///      mainnet eid). Cross-chain L2 owner-sync happens later via
    ///      syncTransfer(otherEid); buyer can call that per chain they care about.
    uint32 public immutable lzDestId;

    mapping(uint256 => Listing) public listings;
    mapping(uint32 => uint256) public listingByTokenId;  // tokenId => active listingId (1-indexed)
    mapping(address => bool) public allowedPaymentTokens;
    // bidder => listingId => amount (pull-pattern refunds for English auctions)
    mapping(address => mapping(uint256 => uint256)) public pendingReturns;
    // seller => amount owed (pull-pattern payouts — H-15)
    mapping(address => uint256) public pendingPayouts;

    mapping(uint256 => Offer) public offers;
    uint256 public nextOfferId = 1;

    uint256 public nextListingId = 1; // Start at 1 so 0 means "no listing"

    uint64 public constant ANTI_SNIPE_DURATION = 10 minutes;
    uint256 public constant MIN_BID_INCREMENT_BPS = 500; // 5%
    uint256 public constant AUCTION_DEFAULT_GRACE = 7 days;

    // Events
    event Listed(uint256 indexed listingId, uint32 indexed tokenId, address seller, ListingType listingType, address paymentToken, uint256 startPrice);
    event Sale(uint256 indexed listingId, uint32 indexed tokenId, address buyer, uint256 price, address paymentToken);
    event BidPlaced(uint256 indexed listingId, address bidder, uint256 amount);
    event BidWithdrawn(uint256 indexed listingId, address bidder, uint256 amount);
    event ListingCancelled(uint256 indexed listingId);
    event AuctionSettled(uint256 indexed listingId, address winner, uint256 price);
    event BidReclaimed(uint256 indexed listingId, address bidder, uint256 amount);
    event OfferCreated(uint256 indexed offerId, uint32 indexed tokenId, address offerer, address paymentToken, uint256 amount, uint64 expiry);
    event OfferAccepted(uint256 indexed offerId, uint32 indexed tokenId, address seller, address buyer, uint256 price, address paymentToken);
    event OfferCancelled(uint256 indexed offerId);
    // H-15: pull-pattern seller payouts
    event PayoutQueued(address indexed seller, uint256 amount);
    event PayoutWithdrawn(address indexed seller, address indexed recipient, uint256 amount);
    // H-17: defaulted auction escape hatch
    event AuctionDefaulted(uint256 indexed listingId, address indexed bidder, uint256 amount);

    /// @param _cawProfile The CawProfile (NFT) address.
    /// @param _paymentTokens ERC20 tokens that should be allowed as payment, in
    ///        addition to native ETH (which is always allowed via address(0)).
    ///        Pass an empty array for ETH-only. Duplicates and the zero address
    ///        are both fine — zero is treated as ETH (already on); duplicates
    ///        are idempotent.
    constructor(address _cawProfile, uint32 _lzDestId, address[] memory _paymentTokens) {
        require(_cawProfile != address(0), "Invalid CawProfile address");
        cawProfile = ICawProfileTransfer(_cawProfile);
        lzDestId = _lzDestId;

        // ETH is always allowed.
        allowedPaymentTokens[address(0)] = true;
        for (uint256 i = 0; i < _paymentTokens.length; i++) {
            allowedPaymentTokens[_paymentTokens[i]] = true;
        }
    }

    // ============================================
    // LISTING MANAGEMENT
    // ============================================

    /**
     * @notice Create a new listing for a CawProfile NFT.
     * @param tokenId The NFT token ID to list
     * @param listingType FIXED, DUTCH_AUCTION, or ENGLISH_AUCTION
     * @param paymentToken The ERC20 token for payment (address(0) for ETH)
     * @param startPrice Starting price (or fixed price)
     * @param endPrice Dutch auction floor price (0 for FIXED and ENGLISH)
     * @param duration Duration in seconds
     */
    function createListing(
        uint32 tokenId,
        ListingType listingType,
        address paymentToken,
        uint256 startPrice,
        uint256 endPrice,
        uint64 duration
    ) external nonReentrant returns (uint256 listingId) {
        require(cawProfile.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(
            cawProfile.isApprovedForAll(msg.sender, address(this)) ||
            cawProfile.getApproved(tokenId) == address(this),
            "Marketplace not approved"
        );
        require(listingByTokenId[tokenId] == 0, "Token already listed");
        require(allowedPaymentTokens[paymentToken], "Payment token not allowed");
        require(startPrice > 0, "Price must be > 0");
        require(duration > 0, "Duration must be > 0");

        if (listingType == ListingType.DUTCH_AUCTION) {
            require(endPrice > 0 && endPrice < startPrice, "Invalid Dutch auction prices");
        } else {
            require(endPrice == 0, "endPrice must be 0 for non-Dutch listings");
        }

        listingId = nextListingId++;
        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = startTime + duration;

        listings[listingId] = Listing({
            tokenId: tokenId,
            seller: msg.sender,
            paymentToken: paymentToken,
            listingType: listingType,
            startPrice: startPrice,
            endPrice: endPrice,
            startTime: startTime,
            endTime: endTime,
            highestBid: 0,
            highestBidder: address(0),
            active: true
        });

        listingByTokenId[tokenId] = listingId;

        emit Listed(listingId, tokenId, msg.sender, listingType, paymentToken, startPrice);
    }

    /**
     * @notice Cancel an active listing.
     *         English auctions can only be cancelled if there are no bids.
     */
    /// @notice Cancel a listing. Seller-only. If the listing is an English auction
    ///         with an active highest bidder, that bidder is refunded automatically —
    ///         the seller doesn't need to transfer the NFT away to undo the auction
    ///         (the previous workaround). Outbid bidders' pull-pattern balances in
    ///         pendingReturns are not touched and remain claimable via withdrawBid.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.seller == msg.sender, "Not seller");

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // English auction with a live high bidder: credit the bidder via the
        // pull-pattern instead of pushing the refund. A malicious bidder
        // contract whose receive() reverts could otherwise block the seller
        // from cancelling, forcing the auction to settle in their favor.
        if (
            listing.listingType == ListingType.ENGLISH_AUCTION
            && listing.highestBidder != address(0)
        ) {
            pendingReturns[listing.highestBidder][listingId] += listing.highestBid;
            emit BidReclaimed(listingId, listing.highestBidder, listing.highestBid);
        }

        emit ListingCancelled(listingId);
    }

    // ============================================
    // BUYING (FIXED + DUTCH)
    // ============================================

    /**
     * @notice Buy a listed NFT with ETH (fixed price or Dutch auction).
     */
    function buy(uint256 listingId) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType != ListingType.ENGLISH_AUCTION, "Use placeBid for auctions");
        require(listing.paymentToken == address(0), "Use buyWithToken for ERC20");

        uint256 price = _getCurrentPrice(listing);
        require(msg.value >= price, "Insufficient ETH");

        // Mark as sold
        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // Queue payment to seller (pull pattern — H-15: prevents seller smart
        // wallet reverts from bricking settlement)
        pendingPayouts[listing.seller] += price;
        emit PayoutQueued(listing.seller, price);

        // Transfer NFT to buyer and sync L2 ownership (excess ETH covers LZ fee)
        uint256 lzFee = msg.value - price;
        cawProfile.transferAndSync{value: lzFee}(msg.sender, listing.tokenId, lzDestId, 0);

        emit Sale(listingId, listing.tokenId, msg.sender, price, address(0));
    }

    /**
     * @notice Buy a listed NFT with an ERC20 token (fixed price or Dutch auction).
     */
    function buyWithToken(uint256 listingId, uint256 amount) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType != ListingType.ENGLISH_AUCTION, "Use placeBid for auctions");
        require(listing.paymentToken != address(0), "Use buy for ETH");

        uint256 price = _getCurrentPrice(listing);
        require(amount >= price, "Insufficient amount");

        // Mark as sold
        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // Transfer ERC20 payment to seller
        IERC20(listing.paymentToken).safeTransferFrom(msg.sender, listing.seller, price);

        // Transfer NFT to buyer and sync L2 (msg.value covers LZ fee)
        cawProfile.transferAndSync{value: msg.value}(msg.sender, listing.tokenId, lzDestId, 0);

        emit Sale(listingId, listing.tokenId, msg.sender, price, listing.paymentToken);
    }

    // ============================================
    // ENGLISH AUCTION
    // ============================================

    /**
     * @notice Place a bid on an English auction with ETH.
     */
    function placeBid(uint256 listingId) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(listing.paymentToken == address(0), "Use placeBidWithToken for ERC20");
        require(block.timestamp <= listing.endTime, "Auction ended");
        require(msg.sender != listing.seller, "Seller cannot bid");

        uint256 minBid = listing.highestBid == 0
            ? listing.startPrice
            : listing.highestBid + (listing.highestBid * MIN_BID_INCREMENT_BPS / 10000);
        require(msg.value >= minBid, "Bid too low");

        // Snapshot the prior bidder before mutating state (CEI), then attempt
        // a push refund and fall back to pendingReturns on failure. The 2300
        // gas stipend is enough for an EOA receive but not for a malicious
        // contract to do work or burn meaningful gas. Smart-wallet bidders
        // (Safes, etc.) will hit the fallback and need to call withdrawBid.
        address prevBidder = listing.highestBidder;
        uint256 prevAmount = listing.highestBid;

        listing.highestBid = msg.value;
        listing.highestBidder = msg.sender;

        if (prevBidder != address(0)) {
            (bool ok, ) = prevBidder.call{value: prevAmount, gas: 2300}("");
            if (!ok) {
                pendingReturns[prevBidder][listingId] += prevAmount;
            }
        }

        // Anti-snipe: extend deadline if bid placed in last 10 minutes
        if (listing.endTime - uint64(block.timestamp) < ANTI_SNIPE_DURATION) {
            listing.endTime = uint64(block.timestamp) + ANTI_SNIPE_DURATION;
        }

        emit BidPlaced(listingId, msg.sender, msg.value);
    }

    /**
     * @notice Place a bid on an English auction with an ERC20 token.
     */
    function placeBidWithToken(uint256 listingId, uint256 amount) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(listing.paymentToken != address(0), "Use placeBid for ETH");
        require(block.timestamp <= listing.endTime, "Auction ended");
        require(msg.sender != listing.seller, "Seller cannot bid");

        uint256 minBid = listing.highestBid == 0
            ? listing.startPrice
            : listing.highestBid + (listing.highestBid * MIN_BID_INCREMENT_BPS / 10000);
        require(amount >= minBid, "Bid too low");

        // Transfer tokens from bidder to contract (escrow)
        IERC20(listing.paymentToken).safeTransferFrom(msg.sender, address(this), amount);

        // Queue refund for previous high bidder
        if (listing.highestBidder != address(0)) {
            pendingReturns[listing.highestBidder][listingId] += listing.highestBid;
        }

        listing.highestBid = amount;
        listing.highestBidder = msg.sender;

        // Anti-snipe extension
        if (listing.endTime - uint64(block.timestamp) < ANTI_SNIPE_DURATION) {
            listing.endTime = uint64(block.timestamp) + ANTI_SNIPE_DURATION;
        }

        emit BidPlaced(listingId, msg.sender, amount);
    }

    /**
     * @notice Settle a completed English auction. Anyone can call this.
     */
    function settleAuction(uint256 listingId) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(block.timestamp > listing.endTime, "Auction not ended");
        require(listing.highestBidder != address(0), "No bids");

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // Queue or transfer payment to seller (ETH uses pull pattern — H-15)
        if (listing.paymentToken == address(0)) {
            pendingPayouts[listing.seller] += listing.highestBid;
            emit PayoutQueued(listing.seller, listing.highestBid);
        } else {
            IERC20(listing.paymentToken).safeTransfer(listing.seller, listing.highestBid);
        }

        // Transfer NFT to winner and sync L2 (msg.value covers LZ fee)
        cawProfile.transferAndSync{value: msg.value}(listing.highestBidder, listing.tokenId, lzDestId, 0);

        emit AuctionSettled(listingId, listing.highestBidder, listing.highestBid);
    }

    /**
     * @notice Reclaim escrowed bid funds when the seller no longer owns the NFT.
     *         This is a safety valve: if the seller transfers the NFT away during an
     *         active English auction, the highest bidder (or anyone) can call this to
     *         refund the highest bidder and cancel the listing.
     */
    /**
     * @notice Anyone can clear a stale listing for a token whose seller no
     *         longer owns it. Covers FIXED, DUTCH, and English-with-no-bids
     *         (English-with-bids must use reclaimBid so the bidder is refunded).
     *         Without this, a user who transferred an NFT off-marketplace
     *         while a listing was open is soft-DoSed: createListing reverts
     *         with "Token already listed" and only the original seller can
     *         cancelListing. Audit fix 2026-05-08 (Round 4 marketplace MED-1).
     */
    function reclaimListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(cawProfile.ownerOf(listing.tokenId) != listing.seller, "Seller still owns NFT");
        require(
            listing.listingType != ListingType.ENGLISH_AUCTION || listing.highestBidder == address(0),
            "Use reclaimBid"
        );

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;
        emit ListingCancelled(listingId);
    }

    function reclaimBid(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(listing.highestBidder != address(0), "No bids to reclaim");

        // The seller must no longer own the NFT
        address currentOwner = cawProfile.ownerOf(listing.tokenId);
        require(currentOwner != listing.seller, "Seller still owns NFT");

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // Pull-pattern refund — see cancelListing for the rationale. A
        // malicious bidder contract that reverts on receive() must not be able
        // to permanently brick listingByTokenId[tokenId] by blocking the
        // refund, since that would lock the seller out of relisting forever.
        pendingReturns[listing.highestBidder][listingId] += listing.highestBid;

        emit BidReclaimed(listingId, listing.highestBidder, listing.highestBid);
    }

    /**
     * @notice Withdraw outbid funds from an English auction (pull pattern).
     */
    function withdrawBid(uint256 listingId) external nonReentrant {
        _withdrawBidTo(listingId, msg.sender);
    }

    /**
     * @notice Withdraw outbid funds to a recipient of the bidder's choosing.
     *         Required for tokens with admin blocklists (e.g., USDC): if
     *         the bidder ends up blocklisted post-bid, transferring the
     *         refund directly to them reverts forever — they can use this
     *         function to redirect to a non-blocklisted address they
     *         control. Audit fix 2026-05-08 (Marketplace M-1).
     */
    function withdrawBidTo(uint256 listingId, address recipient) external nonReentrant {
        require(recipient != address(0), "Zero address");
        _withdrawBidTo(listingId, recipient);
    }

    function _withdrawBidTo(uint256 listingId, address recipient) internal {
        uint256 amount = pendingReturns[msg.sender][listingId];
        require(amount > 0, "Nothing to withdraw");

        pendingReturns[msg.sender][listingId] = 0;

        Listing storage listing = listings[listingId];
        if (listing.paymentToken == address(0)) {
            (bool sent,) = recipient.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(listing.paymentToken).safeTransfer(recipient, amount);
        }

        emit BidWithdrawn(listingId, msg.sender, amount);
    }

    // ============================================
    // SELLER PAYOUT WITHDRAWAL (H-15)
    // ============================================

    /**
     * @notice Withdraw pending ETH sale proceeds for the caller.
     */
    function withdrawPayouts() external nonReentrant {
        _withdrawPayoutsTo(msg.sender);
    }

    /**
     * @notice Withdraw pending ETH sale proceeds to a recipient of the
     *         seller's choosing. Mirrors withdrawBidTo / cancelOfferTo:
     *         if the seller's address becomes unable to receive ETH, they
     *         can redirect proceeds to another address they control.
     */
    function withdrawPayoutsTo(address recipient) external nonReentrant {
        require(recipient != address(0), "Zero address");
        _withdrawPayoutsTo(recipient);
    }

    function _withdrawPayoutsTo(address recipient) internal {
        uint256 amount = pendingPayouts[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingPayouts[msg.sender] = 0;
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "ETH transfer failed");
        emit PayoutWithdrawn(msg.sender, recipient, amount);
    }

    // ============================================
    // BUY OFFERS
    // ============================================

    /**
     * @notice Create a buy offer on any CawProfile NFT with ETH.
     *         Funds are escrowed in the contract until accepted, cancelled, or expired.
     * @param tokenId The token to make an offer on
     * @param duration How long the offer is valid (seconds)
     */
    function createOfferETH(uint32 tokenId, uint64 duration) external payable nonReentrant returns (uint256 offerId) {
        require(tokenId > 0, "Invalid tokenId"); // CAW token IDs start at 1
        require(msg.value > 0, "Offer must be > 0");
        require(duration > 0, "Duration must be > 0");
        require(allowedPaymentTokens[address(0)], "ETH not allowed");

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            offerer: msg.sender,
            tokenId: tokenId,
            paymentToken: address(0),
            amount: msg.value,
            expiry: uint64(block.timestamp) + duration,
            active: true
        });

        emit OfferCreated(offerId, tokenId, msg.sender, address(0), msg.value, uint64(block.timestamp) + duration);
    }

    /**
     * @notice Create a buy offer on any CawProfile NFT with an ERC20 token.
     *         Tokens are transferred to the contract as escrow.
     * @param tokenId The token to make an offer on
     * @param paymentToken The ERC20 token to pay with
     * @param amount The offer amount
     * @param duration How long the offer is valid (seconds)
     */
    function createOfferERC20(
        uint32 tokenId,
        address paymentToken,
        uint256 amount,
        uint64 duration
    ) external nonReentrant returns (uint256 offerId) {
        require(tokenId > 0, "Invalid tokenId"); // CAW token IDs start at 1
        require(amount > 0, "Offer must be > 0");
        require(duration > 0, "Duration must be > 0");
        require(paymentToken != address(0), "Use createOfferETH for ETH");
        require(allowedPaymentTokens[paymentToken], "Payment token not allowed");

        // Escrow the tokens
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            offerer: msg.sender,
            tokenId: tokenId,
            paymentToken: paymentToken,
            amount: amount,
            expiry: uint64(block.timestamp) + duration,
            active: true
        });

        emit OfferCreated(offerId, tokenId, msg.sender, paymentToken, amount, uint64(block.timestamp) + duration);
    }

    /**
     * @notice Accept a buy offer. Caller must own the NFT and have approved the marketplace.
     *         If the token is currently listed, the listing is cancelled automatically.
     * @param offerId The offer to accept
     */
    function acceptOffer(uint256 offerId) external payable nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.active, "Offer not active");
        require(block.timestamp <= offer.expiry, "Offer expired");

        uint32 tokenId = offer.tokenId;
        require(cawProfile.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(
            cawProfile.isApprovedForAll(msg.sender, address(this)) ||
            cawProfile.getApproved(tokenId) == address(this),
            "Marketplace not approved"
        );

        offer.active = false;

        // Cancel any active listing for this token
        uint256 activeListingId = listingByTokenId[tokenId];
        if (activeListingId != 0) {
            Listing storage listing = listings[activeListingId];
            if (listing.active) {
                // English auctions with bids cannot be cancelled via offer acceptance
                if (listing.listingType == ListingType.ENGLISH_AUCTION && listing.highestBidder != address(0)) {
                    revert("Cannot accept offer while auction has bids");
                }
                listing.active = false;
                listingByTokenId[tokenId] = 0;
                emit ListingCancelled(activeListingId);
            }
        }

        // Queue or transfer payment to seller (ETH uses pull pattern — H-15)
        if (offer.paymentToken == address(0)) {
            pendingPayouts[msg.sender] += offer.amount;
            emit PayoutQueued(msg.sender, offer.amount);
        } else {
            IERC20(offer.paymentToken).safeTransfer(msg.sender, offer.amount);
        }

        // Transfer NFT to offerer and sync L2 (msg.value covers LZ fee)
        cawProfile.transferAndSync{value: msg.value}(offer.offerer, tokenId, lzDestId, 0);

        emit OfferAccepted(offerId, tokenId, msg.sender, offer.offerer, offer.amount, offer.paymentToken);
    }

    /**
     * @notice Cancel an active offer and reclaim escrowed funds.
     *         Can be called by the offerer at any time, or by anyone after expiry.
     */
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.active, "Offer not active");
        require(
            offer.offerer == msg.sender || block.timestamp > offer.expiry,
            "Only offerer can cancel before expiry"
        );
        _refundOffer(offer, offer.offerer);
        emit OfferCancelled(offerId);
    }

    /**
     * @notice Cancel an active offer and refund to a recipient of the
     *         offerer's choosing. Same blocklist-token rationale as
     *         withdrawBidTo: if the offerer becomes blocklisted on the
     *         payment token (USDC etc.), they need a way to redirect
     *         the refund. Audit fix 2026-05-08 (Marketplace M-1).
     *         Only the offerer can use this — callable any time before
     *         the natural cancel-by-anyone window opens at expiry.
     */
    function cancelOfferTo(uint256 offerId, address recipient) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.active, "Offer not active");
        require(offer.offerer == msg.sender, "Only offerer");
        require(recipient != address(0), "Zero address");
        _refundOffer(offer, recipient);
        emit OfferCancelled(offerId);
    }

    function _refundOffer(Offer storage offer, address recipient) internal {
        offer.active = false;
        if (offer.paymentToken == address(0)) {
            (bool sent,) = recipient.call{value: offer.amount}("");
            require(sent, "ETH refund failed");
        } else {
            IERC20(offer.paymentToken).safeTransfer(recipient, offer.amount);
        }
    }

    // ============================================
    // DEFAULTED AUCTION ESCAPE HATCH (H-17)
    // ============================================

    /**
     * @notice Refund the highest bidder if the seller never calls settleAuction
     *         within AUCTION_DEFAULT_GRACE (7 days) after auction end.
     *         This prevents a griefing scenario where a seller lets an English
     *         auction expire without settling, trapping the winning bidder's
     *         funds indefinitely.
     *         Only the highest bidder may call this function.
     */
    function refundDefaultedAuction(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(listing.highestBidder != address(0), "No bids");
        require(block.timestamp > listing.endTime + AUCTION_DEFAULT_GRACE, "Grace period not elapsed");
        require(msg.sender == listing.highestBidder, "Only highest bidder");

        uint256 amount = listing.highestBid;
        address bidder = listing.highestBidder;

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        if (listing.paymentToken == address(0)) {
            // ETH: credit via pendingPayouts so the bidder can withdraw to any
            // address (handles blocklist tokens / receiving-contract edge cases)
            pendingPayouts[bidder] += amount;
            emit PayoutQueued(bidder, amount);
        } else {
            IERC20(listing.paymentToken).safeTransfer(bidder, amount);
        }

        emit AuctionDefaulted(listingId, bidder, amount);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /**
     * @notice Get current price for a listing (relevant for Dutch auctions).
     */
    function getCurrentPrice(uint256 listingId) external view returns (uint256) {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        return _getCurrentPrice(listing);
    }

    // ============================================
    // INTERNAL
    // ============================================

    function _getCurrentPrice(Listing storage listing) internal view returns (uint256) {
        if (listing.listingType == ListingType.FIXED) {
            return listing.startPrice;
        }

        if (listing.listingType == ListingType.DUTCH_AUCTION) {
            uint256 elapsed = block.timestamp - listing.startTime;
            uint256 duration = listing.endTime - listing.startTime;

            if (elapsed >= duration) {
                return listing.endPrice;
            }

            return listing.startPrice - ((listing.startPrice - listing.endPrice) * elapsed / duration);
        }

        // English auction: return current highest bid or start price
        if (listing.highestBid > 0) {
            return listing.highestBid;
        }
        return listing.startPrice;
    }
}
