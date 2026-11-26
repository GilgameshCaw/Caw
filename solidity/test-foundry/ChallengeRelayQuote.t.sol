// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// quoteChallenge / quoteChallengeBatch must quote the payload that relayChallenge /
// relayChallengeBatch actually send, so that paying exactly the quoted nativeFee works.
//
// Real contract: CawChallengeRelay. NOT real: the LayerZero endpoint (SizedFeeEndpoint below).
// It models the one property that matters here: the native fee grows with the message length,
// as in LayerZero V2 (SendLibBase passes the message size to the executor; every PriceFeed
// model prices calldata per byte). Underpaying reverts, overpaying refunds the rest.

import "forge-std/Test.sol";
import "../contracts/CawChallengeRelay.sol";
import { MessagingParams, MessagingReceipt, MessagingFee } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract SizedFeeEndpoint {
    error InsufficientFee(uint256 required, uint256 supplied);
    uint256 public constant BASE = 1e15;
    uint256 public constant PER_BYTE = 1e10;
    uint256 public sends;
    uint256 public lastCharged;
    uint256 public lastMessageLength;

    function setDelegate(address) external {}
    function lzToken() external pure returns (address) { return address(0); }
    function _fee(bytes calldata message) internal pure returns (uint256) { return BASE + PER_BYTE * message.length; }
    function quote(MessagingParams calldata p, address) external pure returns (MessagingFee memory) {
        return MessagingFee(_fee(p.message), 0);
    }
    function send(MessagingParams calldata p, address refund) external payable returns (MessagingReceipt memory r) {
        uint256 fee = _fee(p.message);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);
        sends++;
        lastCharged = fee;
        lastMessageLength = p.message.length;
        uint256 extra = msg.value - fee;
        if (extra > 0) { (bool ok, ) = refund.call{ value: extra }(""); require(ok, "refund"); }
        r.fee = MessagingFee(fee, 0);
    }
}

contract CheckpointsStub {
    function networkHashAtCheckpoint(uint32, uint256 checkpointId) external pure returns (bytes32) {
        return keccak256(abi.encode(checkpointId));
    }
    function networkActionCount(uint32) external pure returns (uint256) { return 1_000; }
}

contract ChallengeRelayQuoteTest is Test {
    uint32 constant DEST = 40231;
    SizedFeeEndpoint ep;
    CawChallengeRelay relay;
    address challenger = address(0xC4A11);

    function setUp() public {
        ep = new SizedFeeEndpoint();
        relay = new CawChallengeRelay(address(ep), address(new CheckpointsStub()), address(this));
        vm.prank(relay.owner());
        relay.setPeer(DEST, bytes32(uint256(uint160(address(0xA2C4)))));
        vm.deal(challenger, 10 ether);
    }

    function _ids(uint256 n) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = i + 1;
    }

    function test_quoteChallenge_exactFee_relayChallenge_succeeds() public {
        MessagingFee memory q = relay.quoteChallenge(DEST, 7, 1, 3, false);
        vm.prank(challenger);
        relay.relayChallenge{ value: q.nativeFee }(DEST, 7, 1, 3);
        assertEq(ep.sends(), 1);
        assertEq(ep.lastCharged(), q.nativeFee, "quote == fee charged for the sent payload");
    }

    function test_quoteChallengeBatch_exactFee_relayChallengeBatch_succeeds() public {
        uint256[] memory ids = _ids(3);
        MessagingFee memory q = relay.quoteChallengeBatch(DEST, 7, 1, ids, false);
        vm.prank(challenger);
        relay.relayChallengeBatch{ value: q.nativeFee }(DEST, 7, 1, ids);
        assertEq(ep.sends(), 1);
        assertEq(ep.lastCharged(), q.nativeFee, "quote == fee charged for the sent payload");
    }

    /// The quoted payload has the same length as the sent one, for several batch sizes.
    function test_quoteChallengeBatch_matchesSentLength_forSeveralSizes() public {
        uint256[4] memory sizes = [uint256(1), 2, 8, 32];
        for (uint256 k = 0; k < sizes.length; k++) {
            uint256[] memory ids = _ids(sizes[k]);
            MessagingFee memory q = relay.quoteChallengeBatch(DEST, 7, 1, ids, false);
            vm.prank(challenger);
            relay.relayChallengeBatch{ value: q.nativeFee + 1 ether }(DEST, 7, 1, ids);
            assertEq(ep.lastCharged(), q.nativeFee, "quote == charged");
            // the sent payload is abi.encode(uint8, uint256, uint32, uint256[], bytes32[])
            assertEq(ep.lastMessageLength(), 32 * 7 + 64 * sizes[k], "sent payload length");
        }
    }

    /// Overpaying still works and the excess comes back (unchanged behaviour).
    function test_overpay_isRefundedToTheCaller() public {
        MessagingFee memory q = relay.quoteChallenge(DEST, 7, 1, 3, false);
        uint256 before = challenger.balance;
        vm.prank(challenger);
        relay.relayChallenge{ value: q.nativeFee * 3 / 2 }(DEST, 7, 1, 3);
        assertEq(before - challenger.balance, q.nativeFee);
    }
}
