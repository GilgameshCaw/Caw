const Test = artifacts.require("Test");
// const CawName = artifacts.require("CawName");
// const CawNameURI = artifacts.require("CawNameURI");
// const CawActions = artifacts.require("CawActions");
// const CawNameMinter = artifacts.require("CawNameMinter");
// const CAW = artifacts.require("MintableCAW");

module.exports = async function (deployer, network) {
  await deployer.deploy(Test);
  // var caw = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';
  // await deployer.deploy(CawNameURI);
  // var uriGenerator = await CawNameURI.deployed();
  // var peerNetwork = {
  //   mainnet: 'base',
  //   base: 'mainnet'
  // }[network];
  //
  // let lzEndpoint = {
  //   mainnet: '0x1a44076050125825900e736c501f859c50fe728c',
  //   dev: '0x1a44076050125825900e736c501f859c50fe728c',
  //   base: '0x1a44076050125825900e736c501f859c50fe728c'
  // }[network];
  //
  // let lzNetworkIds = {
  //   mainnet: 30101,
  //   base: 30184,
  //   dev: 30101,
  // };
  //
  // let peerNetworkId = lzNetworkIds[peerNetwork];
  //
  // console.log("URI generator", uriGenerator.address);
  // await deployer.deploy(CawName, caw, uriGenerator.address, lzEndpoint, peerNetworkId);
  // var cawNames = await CawName.deployed();
  // console.log("DEPLOYED Caw Names: ", cawNames.address)
  //
  // await deployer.deploy(CawNameMinter, caw, cawNames.address);
  // var minter = await CawNameMinter.deployed();
  // console.log("DEPLOYED Minter: ", minter.address)
  //
  // await deployer.deploy(CawActions, cawNames.address);
  // var cawActions = await CawActions.deployed();
  // console.log("DEPLOYed action taker: ", cawActions.address)
  //
  // cawNames.setMinter(minter.address);
  // cawNames.setCawActions(cawActions.address);
};
