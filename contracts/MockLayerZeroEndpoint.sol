// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { EndpointV2Mock } from "@layerzerolabs/test-devtools-evm-hardhat/contracts/mocks/EndpointV2Mock.sol";
import { ILayerZeroEndpointV2 } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract MockLayerZeroEndpoint is EndpointV2Mock {

    constructor(uint32 _eid) EndpointV2Mock(_eid) { }

}

