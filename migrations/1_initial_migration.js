const CawName = artifacts.require("CawName");
const CawNameURI = artifacts.require("CawNameURI");
const CawActions = artifacts.require("CawActions");
const CawNameMinter = artifacts.require("CawNameMinter");

module.exports = async function (deployer) {
  var caw = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';
  await deployer.deploy(CawNameURI);
  var uriGenerator = await CawNameURI.deployed();

  console.log("URI generator", uriGenerator.address);
  await deployer.deploy(CawName, caw, uriGenerator.address);
  var cawNames = await CawName.deployed();
  console.log("DEPLOYED Caw Names: ", cawNames.address)

  await deployer.deploy(CawNameMinter, caw, cawNames.address);
  var minter = await CawNameMinter.deployed();
  console.log("DEPLOYED Minter: ", minter.address)

  await deployer.deploy(CawActions, cawNames.address);
  var cawActions = await CawActions.deployed();
  console.log("DEPLOYed action taker: ", cawActions.address)

  cawNames.setMinter(minter.address);
  cawNames.setCawActions(cawActions.address);
};
