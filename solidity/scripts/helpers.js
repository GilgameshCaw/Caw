
// just run:
// .load ./scripts/helpers.js
//
// buyUsername(accounts[0], 'gilgamesh')
// deposit(accounts[0], 1, 10000)

(async () => {


  l2 = 40245;
  l1 = 40161;


  cawAddress = "0x56817dc696448135203C0556f702c6a953260411";
  uriGeneratorAddress = '0xD28b4EC3CA532053D6AE8023169b185Bdf19773f'
  networkManagerAddress = '0x328b5B2179EFfc94b61D900807312A104A209D6e'
  cawProfilesAddress = '0xec947761e38DBd47e53fe15adc5519CcF2Cc7Ea5'
  cawProfilesL2MainnetAddress = '0xa4d38428641E9285eb2798B418C8634A0fcB8131' 
  cawProfilesMinterAddress = '0x1641b0c89B42D19d58F206b81b170325a3E160aD'
  cawActionsMainnetAddress = '0xfD0Ade8a11BDd8771b3112C91294Edb1597A1F4D'

  token = await MintableCaw.at(cawAddress);
  minter = await CawProfileMinter.at(cawProfilesMinterAddress);
  cawProfiles = await CawProfile.at(cawProfilesAddress);
  cawProfilesL2Mainnet = await CawProfileL2.at(cawProfilesL2MainnetAddress);
  defaultNetworkId = 1;
  //
  //
  //
  // cawActionsMainnet = await CawActions.at(global.cawAddress);

  // uriGenerator;
  // networkManager;


  // First L2 Deploy
//   cawProfilesL2Address = '0x56817dc696448135203C0556f702c6a953260411';
// cawActionsAddress = "0x4C49b7B1F3b02Aa0a0121968a6bC30B593bE7a19";
  // n = await CawProfileL2.at(cawProfilesL2Address)

  // cawProfilesL2;
  // cawActions;

})();

  global.buyUsername = async function(user, name) {

    var balance = await token.balanceOf(user)
    await token.approve(minter.address, balance.toString(), {
      nonce: await web3.eth.getTransactionCount(user),
      from: user,
    });

    var quote = await cawProfiles.mintQuote(defaultNetworkId, false);
    console.log('mint quote returned:', quote);

    t = await minter.mint(defaultNetworkId, name, quote.lzTokenFee, {
      nonce: await web3.eth.getTransactionCount(user),
      value: (BigInt(quote.nativeFee)).toString(),
      from: user,
    });

    return t;
  }

global.deposit = async function(user, tokenId, amount, layer, networkId) {
  networkId ||= defaultNetworkId;
  layer ||= l2;
  console.log("DEPOSIT", tokenId, (BigInt(amount) * 10n**18n).toString());

  var balance = await token.balanceOf(user)
  await token.approve(cawProfiles.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  var cawAmount = (BigInt(amount) * 10n**18n).toString();
  var quote = await cawProfiles.depositQuote(networkId, tokenId, cawAmount, layer, false);
  console.log('deposit quote returned:', quote);

  t = await cawProfiles.deposit(networkId, tokenId, cawAmount, layer, quote.lzTokenFee, {
    nonce: await web3.eth.getTransactionCount(user),
    value: quote.nativeFee,
    from: user,
  });

  return t;
}
