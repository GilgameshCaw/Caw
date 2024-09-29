
// just run:
// .load ./scripts/helpers.js

(async () => {


  l2 = 40245;
  l1 = 40161;


  cawAddress = "0x56817dc696448135203C0556f702c6a953260411";
  clientManagerAddress = '0x4C49b7B1F3b02Aa0a0121968a6bC30B593bE7a19';
  uriGeneratorAddress = '0x02C45606453a0D59aE63a0C4dfb6286831A3b7a6';
  cawNamesAddress = '0x0f63D789Ec19dc390f0e8544932EEA474D6F0BCE';
  cawNamesMinterAddress = "0xd48D3859f77DB1240c8244b2ED9a218AF115eA7A";
  cawNamesL2MainnetAddress = '0x77c997BcB5baa2eEe8f5c1C5236Bf19dB2c71D12';
  cawActionsMainnetAddress = '0x6949149026a91779d4BCEc11dA7BaE506f5e6A93';

  token = await IERC20.at(cawAddress);
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
  cawNamesL2Address = '0x56817dc696448135203C0556f702c6a953260411';
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
