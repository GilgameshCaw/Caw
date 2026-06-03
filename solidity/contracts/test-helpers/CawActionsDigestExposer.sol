// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Test-only helper. Reproduces (does NOT inherit) the
///         CawActions._computeStructHash logic so the EIP-712 digest
///         equivalence tests can run against the Rust circuit without
///         dragging the entire CawActions bytecode into the deploy
///         (CawActions sits within ~60 bytes of EIP-170; inheriting +
///         adding any function pushed this helper past the cap).
///
/// @dev    The struct + typehash + hashing must stay in lockstep with
///         CawActions. Two safeguards: (1) docs in CawActions point here;
///         (2) the equivalence test in test/zk-digest-equivalence-test.js
///         runs both sides and would fail on drift. Audit fix 2026-05-09
///         (Round 7).
contract CawActionsDigestExposer {
    struct ActionData {
        uint8 actionType;
        uint32 senderId;
        uint32 receiverId;
        uint32 receiverCawonce;
        uint32 networkId;
        uint32 cawonce;
        uint32[] recipients;
        uint64[] amounts;
        bytes text;
    }

    bytes32 public immutable eip712DomainHash;
    bytes32 public constant ACTIONDATA_TYPEHASH = keccak256(
        "ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 networkId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Constructor takes the same address-shaped argument as the
    ///      previous (inherited) shape so existing tests don't change.
    ///      The argument is unused in digest computation; the domain hash
    ///      is computed against THIS contract's address, matching how
    ///      CawActions computes its own.
    constructor(address /* _cawProfileLedger */) {
        eip712DomainHash = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("Caw Protocol")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function exposeComputeStructHash(ActionData memory data) public pure returns (bytes32) {
        bytes32 recipHash = keccak256(abi.encodePacked(data.recipients));
        bytes32 amtHash = keccak256(abi.encodePacked(data.amounts));
        bytes32 textHash = keccak256(data.text);
        return keccak256(abi.encode(
            ACTIONDATA_TYPEHASH,
            data.actionType,
            data.senderId,
            data.receiverId,
            data.receiverCawonce,
            data.networkId,
            data.cawonce,
            recipHash,
            amtHash,
            textHash
        ));
    }

    function exposeEip712Digest(ActionData memory data) external view returns (bytes32) {
        bytes32 structHash = exposeComputeStructHash(data);
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), eip712DomainHash, structHash));
    }
}
