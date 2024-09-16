// const Test = artifacts.require("Test");
const CawName = artifacts.require("CawName");
const CawNameURI = artifacts.require("CawNameURI");
const CawActions = artifacts.require("CawActions");
const CawNameMinter = artifacts.require("CawNameMinter");
// const CAW = artifacts.require("MintableCAW");



//    npx truffle deploy --network=testnetL2
//    npx truffle deploy --network=testnetL1
//
//
//
module.exports = async function (deployer, network) {
  // await deployer.deploy(Test);
  var caw = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';
  // await deployer.deploy(CAW);
  // var caw = await CAW.deployed()
  var peerNetwork = {
    L1: 'L2',
    L2: 'L1',
    devL1: 'devL2',
    devL2: 'devL1',
    testnetL1: 'testnetL2',
    testnetL2: 'testnetL1',
  }[network];

  let lzEndpoint = {
    L1: '0x1a44076050125825900e736c501f859c50fe728c',
    L2: '0x1a44076050125825900e736c501f859c50fe728c',
    devL1: '0x1a44076050125825900e736c501f859c50fe728c',
    devL2: '0x1a44076050125825900e736c501f859c50fe728c',
    testnetL2: '0x6EDCE65403992e310A62460808c4b910D972f10f', // base sepolia testnet
    testnetL1: '0x6EDCE65403992e310A62460808c4b910D972f10f', // Holesky Testnet
  }[network];

  let lzNetworkIds = {
    L1: 1,
    L2: 30184,
    devL1: 30101,
    devL2: 40161,
    testnetL1: 40161,
    testnetL2: 40245,
  };

  let peerNetworkId = lzNetworkIds[peerNetwork];

  var cawNamesL2Address;
  if (network.match(/L2/) && !cawNamesL2Address) {
    var cawNamesL2 = await CawNameL2.new(l2Endpoint, peerNetworkId);J
    cawNamesL2Address = cawNamesL2.address;
  }


  var cawNamesAddress;
  if (network.match(/L1/) && cawNamesL2Address) {
    await deployer.deploy(CawNameURI);
    var uriGenerator = await CawNameURI.deployed();

    console.log("URI generator", uriGenerator.address);
    await deployer.deploy(CawName, caw, uriGenerator.address, lzEndpoint, peerNetworkId, cawNamesL2Address);
    var cawNames = await CawName.deployed();
    cawNamesAddress = cawNames.address;
    console.log("Caw Names: ", cawNamesAddress)


    await deployer.deploy(CawNameMinter, caw, cawNamesAddress);
    var minter = await CawNameMinter.deployed();
    console.log("DEPLOYED Minter: ", minter.address)


    await cawNames.setMinter(minter.address);
    console.log("minter set");
  }



  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress) {
    var cawNamesL2 = await CawNames.at(cawNamesL2Address);
    await cawNamesL2.setL1Peer(cawNamesAddress);
    await deployer.deploy(CawActions, cawNamesAddress, lzEndpoint, peerNetworkId);
    var cawActions = await CawActions.deployed();
    console.log("DEPLOYed action taker: ", cawActions.address)

    await cawNamesL2.setCawActions(cawActions.address);
    console.log("Caw Actions Set");
  }

};
