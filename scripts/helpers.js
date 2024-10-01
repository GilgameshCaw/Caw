
// just run:
// .load ./scripts/helpers.js
//
// buyUsername(accounts[0], 'dev')
// deposit(accounts[0], 1, 10000)

(async () => {


  l2 = 40245;
  l1 = 40161;


  cawAddress = "0x56817dc696448135203C0556f702c6a953260411";
  clientManagerAddress = '0xea71Ef236fc57d83eaE1D9247572eda1eCEbE7fD';
  uriGeneratorAddress = '0x4bA43B7aE0C0A1Cc44898DfCE12df7C98C5673c7';
  cawNamesAddress = '0x330773a8443432A078af34984fF70ae2a032dacA';
  cawNamesMinterAddress = "0x0bD9885e67b34F4f141Ed85AF3C2ca599c23AAf4";
  cawNamesL2MainnetAddress = '0xf3FF3891332be3Cb0A28B94218b416454133b26f';
  cawActionsMainnetAddress = '0xfEfc7E1Ef8866fF0B51a237b6CC6496541C7116b';

  token = await MintableCaw.at(cawAddress);
  minter = await CawNameMinter.at(cawNamesMinterAddress);
  cawNames = await CawName.at(cawNamesAddress);
  cawNamesL2Mainnet = await CawNameL2.at(cawNamesL2MainnetAddress);
  defaultClientId = 1;
  //
  //
  //
  // cawActionsMainnet = await CawActions.at(global.cawAddress);

  // uriGenerator;
  // clientManager;


  // First L2 Deploy
//   cawNamesL2Address = '0x56817dc696448135203C0556f702c6a953260411';
// cawActionsAddress = "0x4C49b7B1F3b02Aa0a0121968a6bC30B593bE7a19";
  // n = await CawNameL2.at(cawNamesL2Address)

  // cawNamesL2;
  // cawActions;

})();

  global.buyUsername = async function(user, name) {

    var balance = await token.balanceOf(user)
    await token.approve(minter.address, balance.toString(), {
      nonce: await web3.eth.getTransactionCount(user),
      from: user,
    });

    var quote = await cawNames.mintQuote(defaultClientId, false);
    console.log('mint quote returned:', quote);

    t = await minter.mint(defaultClientId, name, quote.lzTokenFee, {
      nonce: await web3.eth.getTransactionCount(user),
      value: (BigInt(quote.nativeFee)).toString(),
      from: user,
    });

    return t;
  }

global.deposit = async function(user, tokenId, amount, layer, clientId) {
  clientId ||= defaultClientId;
  layer ||= l2;
  console.log("DEPOSIT", tokenId, (BigInt(amount) * 10n**18n).toString());

  var balance = await token.balanceOf(user)
  await token.approve(cawNames.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  var cawAmount = (BigInt(amount) * 10n**18n).toString();
  var quote = await cawNames.depositQuote(clientId, tokenId, cawAmount, layer, false);
  console.log('deposit quote returned:', quote);

  t = await cawNames.deposit(clientId, tokenId, cawAmount, layer, quote.lzTokenFee, {
    nonce: await web3.eth.getTransactionCount(user),
    value: quote.nativeFee,
    from: user,
  });

  return t;
}
