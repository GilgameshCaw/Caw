// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AuditRegressionBase} from "./AuditRegressions2026_06_10.t.sol";
import {CawProfileQuoter} from "../contracts/CawProfileQuoter.sol";
import {MessagingParams, MessagingReceipt, MessagingFee} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract MessageLengthEndpoint {
    uint256 public lastLength;
    function quote(MessagingParams calldata params, address) external pure returns (MessagingFee memory) {
        return MessagingFee(params.message.length, 0);
    }
    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory receipt) {
        lastLength = params.message.length;
    }
}

contract MintQuoteSizeTest is AuditRegressionBase {
    function checkMintSize(uint256 size) internal {
        address endpoint = address(cawProfile.endpoint());
        vm.etch(endpoint, type(MessageLengthEndpoint).runtimeCode);
        vm.prank(cawProfile.owner());
        cawProfile.setPeer(2, bytes32(uint256(uint160(USER))));
        CawProfileQuoter quoter = new CawProfileQuoter(address(cawProfile));
        vm.prank(address(0)); // eth_call without a from address
        uint256 quoted = quoter.mintAndDepositQuote(NETWORK_ID, 1 ether, 2, false).nativeFee;
        bytes memory name = new bytes(size);
        for (uint256 i; i < size; ++i) name[i] = "a";
        cawToken.approve(address(cawProfile), 1 ether);
        cawProfile.mintAndDeposit(NETWORK_ID, USER, string(name), TOKEN_ID, 1 ether, 2, 0, "", 0, 0);
        uint256 sent = MessageLengthEndpoint(endpoint).lastLength();
        assertGt(sent, 0);
        assertEq(quoted, sent + 256 - ((size + 31) / 32) * 32);
    }

    function test_oneByteName() public { checkMintSize(1); }
    function test_crossesFirstWord() public { checkMintSize(33); }
    function test_maximumName() public { checkMintSize(255); }
}
