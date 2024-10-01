// const Test = artifacts.require("Test");
const CawName = artifacts.require("CawName");
const CawNameL2 = artifacts.require("CawNameL2");
const CawClientManager = artifacts.require("CawClientManager");
const CawNameURI = artifacts.require("CawNameURI");
const CawActions = artifacts.require("CawActions");
const CawNameMinter = artifacts.require("CawNameMinter");
const CAW = artifacts.require("MintableCAW");
const EndpointV2 = artifacts.require("ILayerZeroEndpointV2");



//    npx truffle deploy --network=testnetL2
//    npx truffle deploy --network=testnetL1
//
//
//
module.exports = async function (deployer, network, accounts) {
  // await deployer.deploy(Test);
  // var cawAddress = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';
  //
  //
  var cawAddress;
  var cawNamesAddress;
  var cawNamesL2Address;
  var cawActionsAddress;
  var uriGeneratorAddress;
  var clientManagerAddress;
  var cawNamesMinterAddress;
  var cawNamesL2MainnetAddress;
  var cawActionsMainnetAddress;
  var buyAndBurnAddress = accounts[0];



  if (network.match(/dev/)) {
    // First L1 deploy (mintable CAW)
    cawAddress = "0x5fe2f174fe51474Cd198939C96e7dB65983EA307";

    // First L2 Deploy
    // cawNamesL2Address = '0x8AFB0C54bAE39A5e56b984DF1C4b5702b2abf205';

    // Second L1 Deploy
    cawNamesAddress = '0x6B763F54D260aFF608CbbAeD8721c96992eC24Db';
    uriGeneratorAddress = '0x5fe2f174fe51474Cd198939C96e7dB65983EA307';
    clientManagerAddress = '0x8AFB0C54bAE39A5e56b984DF1C4b5702b2abf205';
    cawNamesMinterAddress = '0x061FB3749C4eD5e3c2d28a284940093cfDFcBa20';
    cawNamesL2MainnetAddress = '0xF48883F2ae4C4bf4654f45997fE47D73daA4da07';
    cawActionsMainnetAddress = '0x6949149026a91779d4BCEc11dA7BaE506f5e6A93';


    cawNamesL2Address = '0x5fe2f174fe51474Cd198939C96e7dB65983EA307';
    cawActionsAddress = '0x81ED8e0325B17A266B2aF225570679cfd635d0bb';


  } else if (network.match(/testnet/)) {
    // First L1 Deploy
    cawAddress = "0x56817dc696448135203C0556f702c6a953260411";

    // // First L2 Deploy
    cawNamesL2Address = '0x07E59E70A03cEB68f2d73CCFF479b6CEabBa165c';
    // //
    // // // Second L1 Deploy
    clientManagerAddress = '0xea71Ef236fc57d83eaE1D9247572eda1eCEbE7fD';
    uriGeneratorAddress = '0x4bA43B7aE0C0A1Cc44898DfCE12df7C98C5673c7';
    cawNamesAddress = '0x330773a8443432A078af34984fF70ae2a032dacA';
    cawNamesMinterAddress = "0x0bD9885e67b34F4f141Ed85AF3C2ca599c23AAf4";
    cawNamesL2MainnetAddress = '0xf3FF3891332be3Cb0A28B94218b416454133b26f';
    cawActionsMainnetAddress = '0xfEfc7E1Ef8866fF0B51a237b6CC6496541C7116b';
    //
    // // Second L2 Deploy
    cawActionsAddress = "0xBab5E0ca318E713FB32675E6eE5e5eF6b3c877FF";
  } else {
    cawAddress = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';

    // First L2 Deploy
    cawNamesL2Address;

    // Second L1 Deploy
    clientManagerAddress;
    uriGeneratorAddress;
    cawNamesAddress;
    cawNamesMinterAddress;
    cawNamesL2MainnetAddress;
    cawActionsMainnetAddress;

    // Second L2 Deploy
    cawActionsAddress;
  }



  if (!cawAddress) {
    await deployer.deploy(CAW);
    cawAddress = (await CAW.deployed()).address;
  }
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
    testnetL1: '0x6EDCE65403992e310A62460808c4b910D972f10f', // sepolia Testnet
  }[network];

  let dvnAddress = {
    testnetL1: "0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193",
    testnetL2: "0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6",
    L1:"0x589dedbd617e0cbcb916a9223f4d1300c294236b",
    L2: "0x9e059a54699a285714207b43b055483e78faac25",
    devL1: '0x0000000000000000000000000000000000000000',
    devL2: '0x0000000000000000000000000000000000000000',
  }[network];

  let lzNetworkIds = {
    L1: 30101,
    L2: 30184,
    devL1: 30101,
    devL2: 40161,
    testnetL1: 40161,
    testnetL2: 40245,
  };

  let peerNetworkId = lzNetworkIds[peerNetwork];
  let networkId = lzNetworkIds[network];

  if (network.match(/L2/) && !cawNamesL2Address) {
    var cawNamesL2 = await deployer.deploy(CawNameL2, lzEndpoint);
    cawNamesL2Address = (await CawNameL2.deployed()).address;
  }

    console.log("ready to go!!!");

  if (network.match(/L1/) && cawNamesL2Address && !cawActionsMainnetAddress) {
    if (!uriGeneratorAddress) {
      await deployer.deploy(CawNameURI);
      var uriGenerator = await CawNameURI.deployed();
      uriGeneratorAddress = uriGenerator.address;
      console.log("URI generator address: ", uriGeneratorAddress);
    }


    if (!clientManagerAddress) {
      await deployer.deploy(CawClientManager, buyAndBurnAddress);
      var clientManager = await CawClientManager.deployed();
      clientManagerAddress = clientManager.address;
      console.log("client manager address", clientManagerAddress);

      await clientManager.createClient(accounts[0], 1,1,1,1);
      console.log("first client created");
    }

    var cawNames;
    if (!cawNamesAddress) {
      console.log("WILL DEPLOY",
        !CawName,
        cawAddress,
        uriGeneratorAddress,
        buyAndBurnAddress,
        clientManagerAddress,
        lzEndpoint,
        networkId
      );
      await deployer.deploy(
        CawName,
        cawAddress,
        uriGeneratorAddress,
        buyAndBurnAddress,
        clientManagerAddress,
        lzEndpoint,
        networkId
      );
      cawNames = await CawName.deployed();
      console.log("Caw Names address", cawNames.address);
      cawNamesAddress = cawNames.address;
    } else cawNames = await CawName.at(cawNamesAddress);
    console.log("GOT caw names");


    var cawNamesL2Mainnet;
    if (!cawNamesL2MainnetAddress) {
      cawNamesL2Mainnet = await deployer.deploy(CawNameL2, lzEndpoint);
      console.log("Caw Names L2 on Mainnet", cawNamesL2Mainnet.address);
      cawNamesL2MainnetAddress = cawNamesL2Mainnet.address;
    } else cawNamesL2Mainnet = await CawNameL2.at(cawNamesL2MainnetAddress);
    console.log("GOT L2 mainnet");

    if (!(await cawNamesL2Mainnet.bypassLZ())) { 
      await cawNamesL2Mainnet.setL1Peer(networkId, cawNamesAddress, true)
      console.log("mainnetL2's L1 peer set");
    }

    await cawNames.setL2Peer(networkId, cawNamesL2MainnetAddress);
    console.log("L1's  peer set");

    await cawNames.setL2Peer(peerNetworkId, cawNamesL2Address);
    console.log("L1's  l2 peer set");


    await deployer.deploy(CawNameMinter, cawAddress, cawNamesAddress);
    var minter = await CawNameMinter.deployed();
    console.log("DEPLOYED Minter: ", minter.address)


    await cawNames.setMinter(minter.address);
    console.log("minter set");

    await deployer.deploy(CawActions, cawNamesL2MainnetAddress);
    var cawActionsMainnet = await CawActions.deployed();
    await cawNamesL2Mainnet.setCawActions(cawActionsMainnet.address);
  }



  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress) {
    var cawNamesL2 = await CawNameL2.at(cawNamesL2Address);
    if (parseInt(await cawNamesL2.peers(peerNetworkId),16) == 0) {
      await cawNamesL2.setL1Peer(peerNetworkId, cawNamesAddress, false);
      console.log("L1 peer set")
    }
  }

  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress && !cawActionsAddress) {
    await deployer.deploy(CawActions, cawNamesL2Address);
    var cawActions = await CawActions.deployed();
    console.log("DEPLOYed action ", cawActions.address)

    await cawNamesL2.setCawActions(cawActions.address);
    console.log("Caw Actions Set");
  }

};
