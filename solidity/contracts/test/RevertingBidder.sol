// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMarketplaceForBid {
    function placeBid(uint256 listingId) external payable;
}

/// @title RevertingBidder
/// @notice Test-only contract that places bids on the marketplace and reverts
///         on receive(), exercising the push-refund fallback path in placeBid.
contract RevertingBidder {
    IMarketplaceForBid public immutable marketplace;

    constructor(address _marketplace) {
        marketplace = IMarketplaceForBid(_marketplace);
    }

    function placeBid(uint256 listingId) external payable {
        marketplace.placeBid{value: msg.value}(listingId);
    }

    receive() external payable {
        revert("RevertingBidder: nope");
    }
}
