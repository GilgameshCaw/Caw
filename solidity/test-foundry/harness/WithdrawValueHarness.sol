// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Shared setup for the tests of how CawActions / CawActionsERC1271 account for the native value
// (`msg.value`) of a processing call.
// Real contracts: CawActions, CawActionsERC1271, CawProfileLedger.
// NOT real: the LayerZero endpoint (StubEndpoint below). It models the one behaviour that matters
// here, which the OApp/endpoint code documents: `send` takes the quoted fee and refunds the
// rest of msg.value to the refund address (the ledger passes tx.origin).

import "forge-std/Test.sol";
import "../../contracts/CawActions.sol";
import "../../contracts/CawActionsERC1271.sol";
import "../../contracts/CawProfileLedger.sol";
import "../../contracts/test-helpers/MockSP1Verifier.sol";
import "../mocks/SmartContractWalletMock.sol";
import { MessagingParams, MessagingReceipt, MessagingFee, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract StubEndpoint {
    uint256 public immutable FEE;
    uint256 public sends;
    constructor(uint256 fee) { FEE = fee; }
    function setDelegate(address) external {}
    function lzToken() external pure returns (address) { return address(0); }
    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) { return MessagingFee(FEE, 0); }
    function send(MessagingParams calldata, address refund) external payable returns (MessagingReceipt memory r) {
        require(msg.value >= FEE, "StubEndpoint: fee");
        sends++;
        uint256 extra = msg.value - FEE;
        if (extra > 0) { (bool ok,) = refund.call{value: extra}(""); require(ok, "StubEndpoint: refund"); }
        r.fee = MessagingFee(FEE, 0);
    }
}

abstract contract WithdrawValueHarness is Test {
    uint32 constant NETWORK_ID   = 1;
    uint32 constant TOKEN_A      = 10;
    uint32 constant TOKEN_W      = 30; // owned by an ERC-1271 wallet
    uint32 constant VALIDATOR_ID = 99;
    uint256 constant OWNER_PK    = 0xA11CE1;
    uint256 constant FEE         = 0.001 ether; // the "actual" LayerZero fee of the stub

    StubEndpoint ep;
    MockSP1Verifier verifier;
    CawProfileLedger ledger;
    CawActions actions;
    CawActionsERC1271 sibling;
    SmartContractWalletMock wallet;
    address owner;
    address validatorEoa = address(0xA1);
    address thief        = address(0xB2);

    uint256 public setWithdrawableCalls; // this test contract plays the L1 CawProfile in bypassLZ mode

    // ---- stand-in for the L1 CawProfile (bypassLZ mode only) ----
    function setWithdrawable(uint32[] memory, uint256[] memory) external { setWithdrawableCalls++; }

    receive() external payable {}

    function _deploy(bool bypass) internal {
        owner  = vm.addr(OWNER_PK);
        wallet = new SmartContractWalletMock();
        ep       = new StubEndpoint(FEE);
        verifier = new MockSP1Verifier();
        uint64 n = vm.getNonce(address(this));
        address pLedger  = vm.computeCreateAddress(address(this), n);
        address pActions = vm.computeCreateAddress(address(this), n + 1);
        address pSibling = vm.computeCreateAddress(address(this), n + 2);
        ledger = new CawProfileLedger(30101, address(ep), address(0), address(this), pActions, pSibling, bypass, address(this));
        actions = new CawActions(address(ledger), address(verifier), bytes32(uint256(1)), pSibling, address(0), 0, 0);
        sibling = new CawActionsERC1271(address(actions));
        require(address(ledger) == pLedger && address(actions) == pActions && address(sibling) == pSibling, "addr");
        _token(TOKEN_A, owner, 1_000_000e18, bypass);
        _token(TOKEN_W, address(wallet), 1_000_000e18, bypass);
        _token(VALIDATOR_ID, address(this), 0, bypass);
    }

    function _token(uint32 id, address who, uint256 amount, bool bypass) internal {
        if (bypass) {
            ledger.mint(id, who, "t", 1);
            ledger.auth(NETWORK_ID, id, address(0));
            if (amount > 0) ledger.deposit(NETWORK_ID, id, amount, who);
        } else {
            uint32[] memory ids = new uint32[](1); ids[0] = id;
            address[] memory os = new address[](1); os[0] = who;
            uint64[] memory st = new uint64[](1); st[0] = 1;
            bytes memory payload = bytes.concat(new bytes(36), abi.encodeWithSelector(
                ledger.lzDepositMintSession.selector,
                NETWORK_ID, id, amount, "t", address(0), uint64(0), uint256(0), uint64(0), ids, os, st));
            vm.prank(address(ep));
            ledger.lzReceive(Origin(30101, bytes32(uint256(uint160(address(this)))), 1), bytes32(0), payload, address(0), "");
        }
    }

    // ---- packing (layout from CawActions.sol L293-310; same as SessionProfileScoping.t.sol) ----
    function _action(uint8 t, uint32 sid, uint32 cawonce, uint64 amount) internal pure returns (bytes memory) {
        if (t == 6) { // WITHDRAW: one recipient slot + one amount (recipients=[] would be the H-2 shape that is refused)
            return abi.encodePacked(t, sid, uint32(0), uint32(0), NETWORK_ID, cawonce, uint8(1), uint8(1), sid, amount, uint16(0));
        }
        return abi.encodePacked(t, sid, uint32(0), uint32(0), NETWORK_ID, cawonce, uint8(0), uint8(0), uint16(0));
    }
    function _packed(uint8 t, uint32 sid, uint32 cawonce, uint64 amount) internal pure returns (bytes memory) {
        return bytes.concat(abi.encodePacked(uint16(1)), _action(t, sid, cawonce, amount));
    }
    function _digest(uint8 t, uint32 sid, uint32 cawonce, uint64 amount) internal view returns (bytes32) {
        bytes32 th = keccak256("ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)");
        uint32[] memory rec; uint64[] memory am;
        if (t == 6) { rec = new uint32[](1); rec[0] = sid; am = new uint64[](1); am[0] = amount; }
        else { rec = new uint32[](0); am = new uint64[](0); }
        bytes32 sh = keccak256(abi.encode(th, uint256(t), uint256(sid), uint256(0), uint256(0), uint256(NETWORK_ID), uint256(cawonce),
            keccak256(abi.encodePacked(rec)), keccak256(abi.encodePacked(am)), keccak256(new bytes(0))));
        return keccak256(abi.encodePacked("\x19\x01", actions.eip712DomainHash(), sh));
    }
    function _sigs(uint8 t, uint32 sid, uint32 cawonce, uint64 amount, bool good) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, _digest(t, sid, cawonce, amount));
        if (!good) s = bytes32(uint256(s) ^ 1);
        return abi.encodePacked(uint16(1), uint16(1), v, r, s);
    }

    function _send(address caller, uint256 value, bytes memory packed, bytes memory sigs, uint256 fee) internal {
        vm.deal(caller, caller.balance + value);
        vm.prank(caller, caller);
        actions.processActions{value: value}(VALIDATOR_ID, packed, sigs, fee, 0);
    }

    function _erc1271(address caller, uint256 value, uint32 cawonce, uint256 fee) internal {
        bytes memory packed = abi.encodePacked(uint16(1), _action(6, TOKEN_W, cawonce, 10));
        bytes[] memory sigs = new bytes[](1); sigs[0] = hex"01";
        bytes32[] memory rs = new bytes32[](1); rs[0] = keccak256(sigs[0]);
        vm.deal(caller, caller.balance + value);
        vm.prank(caller, caller);
        sibling.processActionsERC1271{value: value}(VALIDATOR_ID, packed, sigs, rs, fee, 0);
    }

}
