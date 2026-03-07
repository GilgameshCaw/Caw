// const Test = artifacts.require("Test");
const CawName = artifacts.require("CawName");
const CAW = artifacts.require("MintableCaw");
const CawNameL2 = artifacts.require("CawNameL2");
const CawClientManager = artifacts.require("CawClientManager");
const CawNameURI = artifacts.require("CawNameURI");
const CawActions = artifacts.require("CawActions");
const CawNameMinter = artifacts.require("CawNameMinter");
const EndpointV2 = artifacts.require("ILayerZeroEndpointV2");
const CawActionsReplicator = artifacts.require("CawActionsReplicator");
const CawActionsArchive = artifacts.require("CawActionsArchive");



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
  var cawActionsArchiveAddress;
  var cawActionsReplicatorAddress;
  var buyAndBurnAddress = accounts[0];



  if (network.match(/dev/)) {
    // First L1 deploy (mintable CAW)
    cawAddress = "0x5fe2f174fe51474Cd198939C96e7dB65983EA307";

    // First L2 Deploy
    cawNamesL2Address = '0x8AFB0C54bAE39A5e56b984DF1C4b5702b2abf205';

    // Second L1 Deploy
    uriGeneratorAddress = '0x5fe2f174fe51474Cd198939C96e7dB65983EA307';
    cawNamesAddress = '0x6B763F54D260aFF608CbbAeD8721c96992eC24Db';
    clientManagerAddress = '0x8AFB0C54bAE39A5e56b984DF1C4b5702b2abf205';
    cawNamesL2MainnetAddress = '0xF48883F2ae4C4bf4654f45997fE47D73daA4da07';
    cawNamesMinterAddress = '0x061FB3749C4eD5e3c2d28a284940093cfDFcBa20';
    cawActionsMainnetAddress = '0x6949149026a91779d4BCEc11dA7BaE506f5e6A93';


    cawNamesL2Address = '0x5fe2f174fe51474Cd198939C96e7dB65983EA307';
    cawActionsAddress = '0x81ED8e0325B17A266B2aF225570679cfd635d0bb';

    // Archive chain deploy (devArchive)
    // cawActionsArchiveAddress = '';
    // cawActionsReplicatorAddress = '';

  } else if (network.match(/testnet/)) {
    // First L1 Deploy
    // // npx truffle deploy --network testnetL1
    cawAddress = "0x56817dc696448135203C0556f702c6a953260411";

    // // First L2 Deploy
    // // npx truffle deploy --network testnetL2
    cawNamesL2Address = "0xfD0Ade8a11BDd8771b3112C91294Edb1597A1F4D"
    // // //
    // // // // Second L1 Deploy
    // // npx truffle deploy --network testnetL1
    //
    uriGeneratorAddress = '0x4FD239922c1678abAc2F4BEFc40b6dD2A9266522'
    clientManagerAddress = '0x13409039fdEb5011C90327C33812871882987BBd'
    cawNamesAddress = '0x4ef125b425A73Ca45a7F8AA65e5E5be0400bCdF9'
    cawNamesL2MainnetAddress = '0xB7648984908d4f41c361c132a6Da7e6fB252bDb5' 
    cawNamesMinterAddress = '0xDc96e6C7E42B1200A5CBE3F5Ab12cEb4d93A24bB'
    cawActionsMainnetAddress = '0x4D45a77c7724c5b71F3757cCAEC55b5B8f04955d'
    // //
    // // // Second L2 Deploy
    // // npx truffle deploy --network testnetL2
    cawActionsAddress = "0x793b884C8e64166d3faCDD03115F168Dbf539ae1"

    // // Archive chain deploy
    // // npx truffle deploy --network testnetArchive
    // cawActionsArchiveAddress = '';
    // // Then on L2:
    // // npx truffle deploy --network testnetL2
    // cawActionsReplicatorAddress = '';
  } else {
    cawAddress = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';

    // First L2 Deploy
    cawNamesL2Address;

    // Second L1 Deploy
    uriGeneratorAddress;
    clientManagerAddress;
    cawNamesAddress;
    cawNamesL2MainnetAddress;
    cawNamesMinterAddress;
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
    devArchive: '0x1a44076050125825900e736c501f859c50fe728c',
    testnetL2: '0x6EDCE65403992e310A62460808c4b910D972f10f', // base sepolia testnet
    testnetL1: '0x6EDCE65403992e310A62460808c4b910D972f10f', // sepolia Testnet
    testnetArchive: '0x6EDCE65403992e310A62460808c4b910D972f10f', // arbitrum sepolia testnet
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
    Archive: 30110, // Arbitrum mainnet
    devL1: 30101,
    devL2: 40161,
    devArchive: 40231, // Arbitrum Sepolia (for dev, use same as testnet)
    testnetL1: 40161,
    testnetL2: 40245,
    testnetArchive: 40231, // Arbitrum Sepolia
  };

  let peerNetworkId = lzNetworkIds[peerNetwork];
  let networkId = lzNetworkIds[network];

  if (network.match(/L2/) && !cawNamesL2Address) {
    var cawNamesL2 = await deployer.deploy(CawNameL2, peerNetworkId, lzEndpoint);
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
      cawNamesL2Mainnet = await deployer.deploy(CawNameL2, peerNetworkId, lzEndpoint);
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

    // Deploy CawActions on L1 first (without replicator - will be zero address)
    // Replication on L1 requires a separate deployment pass after CawNameL2Mainnet is ready
    await deployer.deploy(CawActions, cawNamesL2MainnetAddress, "0x0000000000000000000000000000000000000000");
    var cawActionsMainnet = await CawActions.deployed();
    console.log("CawActions (L1) deployed at:", cawActionsMainnet.address);
    cawActionsMainnetAddress = cawActionsMainnet.address;

    await cawNamesL2Mainnet.setCawActions(cawActionsMainnet.address);
    console.log("CawActions linked to CawNameL2 (mainnet)");

    // Note: To enable L1 replication, you need a separate deployment:
    // 1. Deploy CawActionsReplicator with (lzEndpoint, cawActionsMainnetAddress, cawNamesL2MainnetAddress)
    // 2. Redeploy CawActions with the replicator address
    // 3. Re-link CawNameL2Mainnet to the new CawActions
    // This is optional - most replication will happen on L2 where most actions occur.
  }



  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress) {
    var cawNamesL2 = await CawNameL2.at(cawNamesL2Address);
    if (parseInt(await cawNamesL2.peers(peerNetworkId),16) == 0) {
      await cawNamesL2.setL1Peer(peerNetworkId, cawNamesAddress, false);
      console.log("L1 peer set")
    }
  }

  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress && !cawActionsAddress) {
    var cawNamesL2 = await CawNameL2.at(cawNamesL2Address);

    // Deploy CawActions first without replicator (chicken-and-egg: replicator needs CawActions address)
    await deployer.deploy(CawActions, cawNamesL2Address, "0x0000000000000000000000000000000000000000");
    var cawActions = await CawActions.deployed();
    cawActionsAddress = cawActions.address;
    console.log("CawActions (L2) deployed at:", cawActionsAddress);

    await cawNamesL2.setCawActions(cawActions.address);
    console.log("CawActions linked to CawNameL2");

    // Now deploy CawActionsReplicator with the CawActions address
    await deployer.deploy(CawActionsReplicator, lzEndpoint, cawActionsAddress, cawNamesL2Address);
    var cawActionsReplicator = await CawActionsReplicator.deployed();
    cawActionsReplicatorAddress = cawActionsReplicator.address;
    console.log("CawActionsReplicator deployed at:", cawActionsReplicatorAddress);

    // Link CawNameL2 to replicator so it can forward peer updates
    await cawNamesL2.setCawActionsReplicator(cawActionsReplicatorAddress);
    console.log("CawNameL2 linked to replicator");

    // IMPORTANT: CawActions was deployed without replicator (immutable).
    // To enable replication, you must redeploy CawActions in a second pass:
    // 1. Set cawActionsReplicatorAddress in the config above
    // 2. Comment out the CawActions deployment above
    // 3. Uncomment and run the following:
    //
    // await deployer.deploy(CawActions, cawNamesL2Address, cawActionsReplicatorAddress);
    // var cawActionsWithReplicator = await CawActions.deployed();
    // await cawNamesL2.setCawActions(cawActionsWithReplicator.address);
    // console.log("CawActions (with replicator) deployed at:", cawActionsWithReplicator.address);
    //
    console.log("");
    console.log("=== REPLICATION SETUP REQUIRED ===");
    console.log("CawActions deployed WITHOUT replicator (immutable field).");
    console.log("To enable replication, update the migration script with the replicator address");
    console.log("and redeploy CawActions. See comments in migration script.");
    console.log("Replicator address:", cawActionsReplicatorAddress);
  }

  // ==========================================
  // L1 POST-DEPLOYMENT: LINK CawName to CawClientManager and CawNameL2
  // ==========================================
  // CawClientManager routes replication config through CawName -> CawNameL2 -> Replicator
  // This is set up automatically when CawName is deployed with clientManagerAddress

  if (network.match(/L1/) && cawNamesAddress && clientManagerAddress) {
    var clientManager = await CawClientManager.at(clientManagerAddress);

    // Set CawName and default L2 eid on ClientManager so it can route replication sync calls
    if ((await clientManager.cawName()) === '0x0000000000000000000000000000000000000000') {
      await clientManager.setCawName(cawNamesAddress, peerNetworkId);
      console.log("CawName and default L2 eid set on ClientManager");
    }
  }

  // ==========================================
  // ARCHIVE CHAIN DEPLOYMENT
  // ==========================================
  //
  // Deployment order:
  // 1. Deploy CawActionsArchive on archive chain (testnetArchive/devArchive)
  // 2. On L1: Call clientManager.addReplication(clientId, archiveEid, archiveAddress)
  //    This syncs via: CawClientManager -> CawName -> CawNameL2 -> CawActionsReplicator
  //    The replicator stores the peer mapping for the client
  //
  // npx truffle deploy --network testnetArchive
  // Then on L1: clientManager.addReplication(clientId, archiveNetworkId, archiveAddress)

  // Deploy CawActionsArchive on archive chain
  if (network.match(/Archive/) && !cawActionsArchiveAddress) {
    await deployer.deploy(CawActionsArchive, lzEndpoint);
    var cawActionsArchive = await CawActionsArchive.deployed();
    cawActionsArchiveAddress = cawActionsArchive.address;
    console.log("CawActionsArchive deployed at:", cawActionsArchiveAddress);
    console.log("");
    console.log("NEXT STEPS:");
    console.log("1. Note down the archive address:", cawActionsArchiveAddress);
    console.log("2. On L1, call: clientManager.addReplication(clientId, archiveEid, archiveAddress)");
    console.log("   archiveEid for this network:", lzNetworkIds[network]);
  }

};

