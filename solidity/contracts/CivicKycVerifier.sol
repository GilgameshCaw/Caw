// contracts/CivicKycVerifier.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IGatewayTokenVerifier {
    function verifyToken(address owner, uint256 network) external view returns (bool);
}

interface IKycVerifier {
    function isVerified(address account) external view returns (bool);
}

/**
 * @title CivicKycVerifier
 * @notice Adapter that bridges Civic's IGatewayTokenVerifier to the
 *         IKycVerifier interface used by CawProfileMinter.unlockWithdraw.
 *         Deploy one per gatekeeper network (e.g. ID-document KYC = network 17).
 */
contract CivicKycVerifier is IKycVerifier {
    IGatewayTokenVerifier public immutable civic;
    uint256 public immutable gatekeeperNetwork;

    constructor(address _civic, uint256 _network) {
        civic = IGatewayTokenVerifier(_civic);
        gatekeeperNetwork = _network;
    }

    function isVerified(address account) external view override returns (bool) {
        return civic.verifyToken(account, gatekeeperNetwork);
    }
}
