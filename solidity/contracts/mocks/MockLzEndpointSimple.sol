// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal LZ EndpointV2 stub that records setConfig calls.
///         Used exclusively in tests — not deployed to any live network.
contract MockLzEndpointSimple {
  struct SetConfigParam {
    uint32 eid;
    uint32 configType;
    bytes  config;
  }

  // Last recorded call
  address public lastOapp;
  address public lastLib;
  uint256 public callCount;

  // Last param from the first SetConfigParam in the array
  uint32  public lastEid;
  uint32  public lastConfigType;
  bytes   public lastConfig;

  function setConfig(
    address oapp,
    address lib,
    SetConfigParam[] calldata params
  ) external {
    lastOapp       = oapp;
    lastLib        = lib;
    lastEid        = params[0].eid;
    lastConfigType = params[0].configType;
    lastConfig     = params[0].config;
    callCount++;
  }
}
