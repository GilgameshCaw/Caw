/**
 * ⚠️  DEPRECATED - DO NOT USE THIS FILE
 *
 * This Truffle migration script is deprecated. Please use the new deployment script instead:
 *
 *   node scripts/deploy.js
 *
 * The new script offers:
 *   - Multi-chain deployment with retry logic
 *   - State persistence (resume from failures)
 *   - Dependency tracking
 *   - Better error handling
 *
 * See scripts/deploy.js for usage instructions.
 */

module.exports = async function (deployer, network, accounts) {
  console.error('\n');
  console.error('═══════════════════════════════════════════════════════════════════════════');
  console.error('  ⚠️   DEPRECATED: This Truffle migration is no longer supported.');
  console.error('');
  console.error('  Please use the new deployment script instead:');
  console.error('');
  console.error('      node scripts/deploy.js');
  console.error('');
  console.error('  For more information, see: scripts/deploy.js');
  console.error('═══════════════════════════════════════════════════════════════════════════');
  console.error('\n');
  return;

  // ─────────────────────────────────────────────────────────────────────────
  // OLD CODE BELOW - KEPT FOR REFERENCE ONLY
  // ─────────────────────────────────────────────────────────────────────────

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
  var cawActionsReplicatorMainnetAddress;



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
    // cawActionsReplicatorMainnetAddress = ''


    cawNamesL2Address = '0x5fe2f174fe51474Cd198939C96e7dB65983EA307';
    cawActionsAddress = '0x81ED8e0325B17A266B2aF225570679cfd635d0bb';

    // Archive chain deploy (devArchive)
    // cawActionsArchiveAddress = '';
    // cawActionsReplicatorAddress = '';

  } else if (network.match(/testnet/)) {
    // First L1 Deploy
    cawAddress = "0x56817dc696448135203C0556f702c6a953260411";

    // // First L2 Deploy
    cawNamesL2Address = ""

    // Second L1 Deploy
    uriGeneratorAddress = ''
    clientManagerAddress = ''
    cawNamesAddress = ''
    cawNamesL2MainnetAddress = '' 
    cawNamesMinterAddress = ''
    cawActionsMainnetAddress = ''
    cawActionsReplicatorMainnetAddress = ''
    // //
    // // // Second L2 Deploy
    cawActionsAddress = ""
    cawActionsReplicatorAddress = '';

    // Archive chain deploy
    cawActionsArchiveAddress = '';
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
    cawActionsReplicatorMainnetAddress;

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

      await clientManager.createClient("CAW Protocol", accounts[0], peerNetworkId, 1,1,1,1);
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
      console.log("will deploy cawnames l2 mainnet")
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


    if (!cawNamesMinterAddress) {
      console.log("deploying caw name minter")
      await deployer.deploy(CawNameMinter, cawAddress, cawNamesAddress);
      var minter = await CawNameMinter.deployed();
      console.log("DEPLOYED Minter: ", minter.address)
    }


    console.log("will set minter on cawNames");
    await cawNames.setMinter(cawNamesMinterAddress);
    console.log("minter set");

    // Deploy CawActions on L1
    var cawActionsMainnet;
    if (!cawActionsMainnetAddress) {
      console.log("deploying CawActions (L1)");
      await deployer.deploy(CawActions, cawNamesL2MainnetAddress);
      var cawActionsMainnet = await CawActions.deployed();
      console.log("CawActions (L1) deployed at:", cawActionsMainnet.address);
      cawActionsMainnetAddress = cawActionsMainnet.address;

      console.log("Will set caw actions (L1) on cawNames mainnet");
      await cawNamesL2Mainnet.setCawActions(cawActionsMainnetAddress);
      console.log("CawActions linked to CawNameL2 (mainnet)");
    } else cawActionsMainnet = await CawActions.at(cawActionsMainnetAddress);


  }

  if (network.match(/L1/)) {
    // Deploy CawActionsReplicator with CawActions address
    if (!cawActionsReplicatorMainnetAddress) {
      await deployer.deploy(CawActionsReplicator, lzEndpoint, cawActionsMainnetAddress, cawNamesL2MainnetAddress);
      var cawActionsReplicatorMainnet = await CawActionsReplicator.deployed();
      cawActionsReplicatorMainnetAddress  = cawActionsReplicatorMainnet.address;
      console.log("CawActionsReplicator (L1) deployed at:", cawActionsReplicatorMainnetAddress);
    }

    cawActionsMainnet = await CawActions.at(cawActionsMainnetAddress);

    // Link replicator to CawActions (one-time setter)
    console.log("will set replicator:");
    await cawActionsMainnet.setReplicator(cawActionsReplicatorMainnetAddress);
    console.log("Replicator linked to CawActions (L1)");

    // Link CawNameL2Mainnet to replicator for peer updates
    console.log("will set replicator on cawNamesL2Mainnet:");
    cawNamesL2Mainnet = await CawNameL2.at(cawNamesL2MainnetAddress);
    await cawNamesL2Mainnet.setCawActionsReplicator(cawActionsReplicatorMainnetAddress);
    console.log("CawNameL2 (mainnet) linked to replicator");
  }



  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress) {
    var cawNamesL2 = await CawNameL2.at(cawNamesL2Address);
    if (parseInt(await cawNamesL2.peers(peerNetworkId),16) == 0) {
      await cawNamesL2.setL1Peer(peerNetworkId, cawNamesAddress, false);
      console.log("L1 peer set")
    }
  }

  if (network.match(/L2/) && cawNamesL2Address && cawNamesAddress && !cawActionsAddress) {

    console.log("will deploy CawActions (L2)");
    // Deploy CawActions
    await deployer.deploy(CawActions, cawNamesL2Address);
    var cawActions = await CawActions.deployed();
    cawActionsAddress = cawActions.address;
    console.log("CawActions (L2) deployed at:", cawActionsAddress);

    var cawNamesL2 = await CawNameL2.at(cawNamesL2Address);
    await cawNamesL2.setCawActions(cawActionsAddress);
    console.log("CawActions linked to CawNameL2");

    // Deploy CawActionsReplicator with the CawActions address
    await deployer.deploy(CawActionsReplicator, lzEndpoint, cawActionsAddress, cawNamesL2Address);
    var cawActionsReplicator = await CawActionsReplicator.deployed();
    cawActionsReplicatorAddress = cawActionsReplicator.address;
    console.log("CawActionsReplicator deployed at:", cawActionsReplicatorAddress);

    // Link replicator to CawActions (one-time setter)
    await cawActions.setReplicator(cawActionsReplicatorAddress);
    console.log("Replicator linked to CawActions");

    // Link CawNameL2 to replicator so it can forward peer updates
    await cawNamesL2.setCawActionsReplicator(cawActionsReplicatorAddress);
    console.log("CawNameL2 linked to replicator");
  }

  // ==========================================
  // L1 POST-DEPLOYMENT: LINK CawName to CawClientManager and CawNameL2
  // ==========================================
  // CawClientManager routes replication config through CawName -> CawNameL2 -> Replicator
  // This is set up automatically when CawName is deployed with clientManagerAddress

  if (network.match(/L1/) && cawNamesAddress && clientManagerAddress) {
    var clientManager = await CawClientManager.at(clientManagerAddress);

    // Set CawName on ClientManager so it can route replication sync calls
    if ((await clientManager.cawName()) === '0x0000000000000000000000000000000000000000') {
      await clientManager.setCawName(cawNamesAddress);
      console.log("CawName set on ClientManager");
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

