// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// The sponsored Minter paths used to pull CAW from tx.origin whenever
// msg.sender was a contract. Any contract reached inside a tx the sponsor
// broadcast (a stale 7702 delegation, or a user-chosen call in a relayed
// SmartEOA.executeBatch) could pick its own depositAmount and drain the
// sponsor's approved CAW pool. These tests pin the fix: tx.origin pays only
// with its own SponsorFunding signature over the exact recipient permit, and
// depositForSponsored never uses tx.origin.

import "forge-std/Test.sol";
import "./PopBBootstrapE2E.t.sol";

/// Attacker contract reached inside a sponsor-originated tx. It passes
/// _checkPermit for itself and asks the Minter to fund a huge deposit.
contract DrainingRecipient {
    bytes4 private constant MAGIC = 0x1626ba7e;
    mapping(address => mapping(uint8 => uint256)) private _nonces;

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) { return MAGIC; }
    function nonceOf(address vc, uint8 at) external view returns (uint256) { return _nonces[vc][at]; }
    function consumeNonce(address vc, uint8 at) external { unchecked { ++_nonces[vc][at]; } }
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function drain(CawProfileMinter m, IERC20Like caw, bytes calldata funderSig) external {
        string memory name = "attackerprofile";
        uint256 burn = m.costOfName(name);
        uint256 avail = caw.allowance(tx.origin, address(m));
        uint256 bal = caw.balanceOf(tx.origin);
        uint256 take = (avail < bal ? avail : bal) - burn;
        m.mintAndDepositSponsored(1, address(this), name, take, 0, 0,
            _nonces[address(m)][1], hex"01", 0, 0, 0, funderSig);
    }

    function drainDeposit(CawProfileMinter m, uint32 tokenId, uint256 amount) external {
        m.depositForSponsored(1, tokenId, amount, 0, 0, _nonces[address(m)][2], hex"01");
    }
}

interface IERC20Like {
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

contract SponsorFunderConsentTest is PopBBootstrapE2ETest {
    DrainingRecipient internal evil;

    function setUp() public override {
        super.setUp();
        evil = new DrainingRecipient();
    }

    function _sign(uint256 pk, bytes32 permitDigest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, minter.sponsorFundingDigest(permitDigest));
        return abi.encodePacked(r, s, v);
    }

    function _evilDigest(uint256 depositAmount) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("MintAndDeposit(uint32 networkId,address recipient,string username,uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce,uint8 kycLevel,uint32 sponsorTokenId,uint256 repayAmount)"),
            uint32(1), address(evil), keccak256(bytes("attackerprofile")), depositAmount,
            uint32(0), uint256(0), uint256(0), uint8(0), uint32(0), uint256(0)
        ));
        return keccak256(abi.encodePacked("\x19\x01", minter.DOMAIN_SEPARATOR(), structHash));
    }

    /// The original audit PoC (C-2) now fails: no funder signature.
    function test_drain_without_funder_sig_reverts() public {
        uint256 before = caw.balanceOf(sponsor);
        vm.prank(sponsor, sponsor); // sponsor broadcasts; evil is reached inside
        vm.expectRevert(CawProfileMinter.FunderConsentMissing.selector);
        evil.drain(minter, IERC20Like(address(caw)), "");
        assertEq(caw.balanceOf(sponsor), before, "sponsor pool untouched");
    }

    /// The attacker signs with their own key: signer != tx.origin.
    function test_drain_with_attacker_signed_funder_sig_reverts() public {
        uint256 burn = minter.costOfName("attackerprofile");
        uint256 take = caw.balanceOf(sponsor) - burn;
        bytes memory sig = _sign(0xA77AC4E2, _evilDigest(take));
        vm.prank(sponsor, sponsor);
        vm.expectRevert(CawProfileMinter.FunderConsentMissing.selector);
        evil.drain(minter, IERC20Like(address(caw)), sig);
    }

    /// A real sponsor signature for a DIFFERENT (small) deposit cannot be
    /// stretched to the large amount the attacker asks for.
    function test_funder_sig_for_other_amount_reverts() public {
        bytes memory sigForSmall = _sign(SPONSOR_PK, _evilDigest(1e18));
        vm.prank(sponsor, sponsor);
        vm.expectRevert(CawProfileMinter.FunderConsentMissing.selector);
        evil.drain(minter, IERC20Like(address(caw)), sigForSmall);
    }

    /// A malformed signature is rejected, not treated as consent.
    function test_garbage_funder_sig_reverts() public {
        vm.prank(sponsor, sponsor);
        vm.expectRevert(CawProfileMinter.FunderConsentMissing.selector);
        evil.drain(minter, IERC20Like(address(caw)), hex"deadbeef");
    }

    /// The high-s twin of a valid sponsor signature is rejected (malleability guard).
    function test_high_s_funder_sig_reverts() public {
        // Valid consent for evil's exact permit...
        uint256 burn = minter.costOfName("attackerprofile");
        uint256 take = caw.balanceOf(sponsor) - burn;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SPONSOR_PK, minter.sponsorFundingDigest(_evilDigest(take)));
        // ...flipped to its high-s form, which ecrecover would still accept.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory twin = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(sponsor, sponsor);
        vm.expectRevert(CawProfileMinter.FunderConsentMissing.selector);
        evil.drain(minter, IERC20Like(address(caw)), twin);
    }

    /// Positive control: with the sponsor's real consent for that exact permit
    /// the mint goes through (so the guard is consent, not a blanket block).
    function test_exact_sponsor_consent_is_honoured() public {
        uint256 burn = minter.costOfName("attackerprofile");
        uint256 take = caw.balanceOf(sponsor) - burn;
        bytes memory sig = _sign(SPONSOR_PK, _evilDigest(take));
        vm.prank(sponsor, sponsor);
        evil.drain(minter, IERC20Like(address(caw)), sig);
        assertEq(caw.balanceOf(sponsor), 0, "sponsor paid exactly what it signed for");
    }

    /// depositForSponsored through a contract pulls from that contract, never
    /// from tx.origin.
    function test_depositForSponsored_through_contract_does_not_spend_tx_origin() public {
        // Give evil a token by minting it directly from the sponsor (direct
        // call, sponsor pays itself, no funderSig needed).
        uint256 nonce = evil.nonceOf(address(minter), 1);
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(1, address(evil), "attackerprofile", 0, 0, 0, nonce, hex"01", 0, 0, 0, "");
        uint32 tokenId = 1;
        assertEq(profile.ownerOf(tokenId), address(evil));

        uint256 before = caw.balanceOf(sponsor);
        vm.prank(sponsor, sponsor);
        vm.expectRevert(); // evil holds no CAW / no allowance
        evil.drainDeposit(minter, tokenId, before);
        assertEq(caw.balanceOf(sponsor), before, "sponsor pool untouched");
    }
}
