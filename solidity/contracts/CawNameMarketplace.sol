// contracts/CawNameMarketplace.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ICawNameTransfer is IERC721 {
    function transferAndSync(address to, uint256 tokenId, uint256 lzTokenAmount) external payable;
}

/**
 * @title CawNameMarketplace
 * @notice Trustless, feeless marketplace for CAW username NFTs.
 *         Supports fixed-price sales, Dutch auctions, English auctions, and buy offers.
 *         0% fees forever — per the CAW manifesto.
 */
contract CawNameMarketplace is ReentrancyGuard, Ownable {
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

    ICawNameTransfer public immutable cawName;

    mapping(uint256 => Listing) public listings;
    mapping(uint32 => uint256) public listingByTokenId;  // tokenId => active listingId (1-indexed)
    mapping(address => bool) public allowedPaymentTokens;
    // bidder => listingId => amount (pull-pattern refunds for English auctions)
    mapping(address => mapping(uint256 => uint256)) public pendingReturns;

    mapping(uint256 => Offer) public offers;
    uint256 public nextOfferId = 1;

    uint256 public nextListingId = 1; // Start at 1 so 0 means "no listing"

    uint64 public constant ANTI_SNIPE_DURATION = 10 minutes;
    uint256 public constant MIN_BID_INCREMENT_BPS = 500; // 5%

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

    constructor(address _cawName) {
        require(_cawName != address(0), "Invalid CawName address");
        cawName = ICawNameTransfer(_cawName);
        // ETH is always allowed (represented by address(0))
        allowedPaymentTokens[address(0)] = true;
    }

    // ============================================
    // LISTING MANAGEMENT
    // ============================================

    /**
     * @notice Create a new listing for a CawName NFT.
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
        require(cawName.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(
            cawName.isApprovedForAll(msg.sender, address(this)) ||
            cawName.getApproved(tokenId) == address(this),
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
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.seller == msg.sender, "Not seller");

        if (listing.listingType == ListingType.ENGLISH_AUCTION) {
            require(listing.highestBidder == address(0), "Cannot cancel auction with bids");
        }

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

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

        // Transfer payment to seller
        (bool sent,) = listing.seller.call{value: price}("");
        require(sent, "ETH transfer failed");

        // Transfer NFT to buyer and sync L2 ownership (excess ETH covers LZ fee)
        uint256 lzFee = msg.value - price;
        cawName.transferAndSync{value: lzFee}(msg.sender, listing.tokenId, 0);

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
        cawName.transferAndSync{value: msg.value}(msg.sender, listing.tokenId, 0);

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

        // Queue refund for previous high bidder (pull pattern)
        if (listing.highestBidder != address(0)) {
            pendingReturns[listing.highestBidder][listingId] += listing.highestBid;
        }

        listing.highestBid = msg.value;
        listing.highestBidder = msg.sender;

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

        // Transfer payment to seller
        if (listing.paymentToken == address(0)) {
            (bool sent,) = listing.seller.call{value: listing.highestBid}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(listing.paymentToken).safeTransfer(listing.seller, listing.highestBid);
        }

        // Transfer NFT to winner and sync L2 (msg.value covers LZ fee)
        cawName.transferAndSync{value: msg.value}(listing.highestBidder, listing.tokenId, 0);

        emit AuctionSettled(listingId, listing.highestBidder, listing.highestBid);
    }

    /**
     * @notice Reclaim escrowed bid funds when the seller no longer owns the NFT.
     *         This is a safety valve: if the seller transfers the NFT away during an
     *         active English auction, the highest bidder (or anyone) can call this to
     *         refund the highest bidder and cancel the listing.
     */
    function reclaimBid(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(listing.listingType == ListingType.ENGLISH_AUCTION, "Not an English auction");
        require(listing.highestBidder != address(0), "No bids to reclaim");

        // The seller must no longer own the NFT
        address currentOwner = cawName.ownerOf(listing.tokenId);
        require(currentOwner != listing.seller, "Seller still owns NFT");

        listing.active = false;
        listingByTokenId[listing.tokenId] = 0;

        // Refund the highest bidder
        address bidder = listing.highestBidder;
        uint256 amount = listing.highestBid;

        if (listing.paymentToken == address(0)) {
            (bool sent,) = bidder.call{value: amount}("");
            require(sent, "ETH refund failed");
        } else {
            IERC20(listing.paymentToken).safeTransfer(bidder, amount);
        }

        emit BidReclaimed(listingId, bidder, amount);
    }

    /**
     * @notice Withdraw outbid funds from an English auction (pull pattern).
     */
    function withdrawBid(uint256 listingId) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][listingId];
        require(amount > 0, "Nothing to withdraw");

        pendingReturns[msg.sender][listingId] = 0;

        Listing storage listing = listings[listingId];
        if (listing.paymentToken == address(0)) {
            (bool sent,) = msg.sender.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(listing.paymentToken).safeTransfer(msg.sender, amount);
        }

        emit BidWithdrawn(listingId, msg.sender, amount);
    }

    // ============================================
    // BUY OFFERS
    // ============================================

    /**
     * @notice Create a buy offer on any CawName NFT with ETH.
     *         Funds are escrowed in the contract until accepted, cancelled, or expired.
     * @param tokenId The token to make an offer on
     * @param duration How long the offer is valid (seconds)
     */
    function createOfferETH(uint32 tokenId, uint64 duration) external payable nonReentrant returns (uint256 offerId) {
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
     * @notice Create a buy offer on any CawName NFT with an ERC20 token.
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
        require(cawName.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(
            cawName.isApprovedForAll(msg.sender, address(this)) ||
            cawName.getApproved(tokenId) == address(this),
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

        // Transfer payment to seller
        if (offer.paymentToken == address(0)) {
            (bool sent,) = msg.sender.call{value: offer.amount}("");
            require(sent, "ETH transfer failed");
        } else {
            IERC20(offer.paymentToken).safeTransfer(msg.sender, offer.amount);
        }

        // Transfer NFT to offerer and sync L2 (msg.value covers LZ fee)
        cawName.transferAndSync{value: msg.value}(offer.offerer, tokenId, 0);

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

        offer.active = false;

        // Refund escrowed funds
        if (offer.paymentToken == address(0)) {
            (bool sent,) = offer.offerer.call{value: offer.amount}("");
            require(sent, "ETH refund failed");
        } else {
            IERC20(offer.paymentToken).safeTransfer(offer.offerer, offer.amount);
        }

        emit OfferCancelled(offerId);
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
    // ADMIN
    // ============================================

    /**
     * @notice Add or remove an allowed payment token.
     */
    function setAllowedPaymentToken(address token, bool allowed) external onlyOwner {
        allowedPaymentTokens[token] = allowed;
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
