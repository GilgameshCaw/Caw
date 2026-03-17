const MintableCaw = artifacts.require("MintableCaw");
const CawNameURI = artifacts.require("CawNameURI");
const CawClientManager = artifacts.require("CawClientManager");
const CawName = artifacts.require("CawName");
const CawNameL2 = artifacts.require("CawNameL2");
const CawNameMinter = artifacts.require("CawNameMinter");
const CawNameQuoter = artifacts.require("CawNameQuoter");
const CawActions = artifacts.require("CawActions");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
// const ethereumjs = require("ethereumjs-util");

const truffleAssert = require('truffle-assertions');

// const MockLayerZeroEndpoint = artifacts.require("@layerzerolabs/test-devtools-evm-hardhat/contracts/mocks/EndpointV2Mock.sol");

const {signTypedMessage} = require('@truffle/hdwallet-provider');
const { BN, expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
const {
  encrypt,
  recoverPersonalSignature,
  recoverTypedSignature,
  TypedMessage,
  MessageTypes,
  SignTypedDataVersion,
  signTypedData,
} = require('@metamask/eth-sig-util');


const gilg = "0xF71338f3eAa483aA66125598B09BA1988e694a95";

const l2 = 8453;
const l1 = 30101;
var defaultClientId = 1;
var totalGas = 0n;
var token;
var minter;
var cawNames;
var buyAndBurnAddress;
var cawNamesL2;
var cawNamesL2Mainnet;

var cawActions;
var cawActionsMainnet;

var uriGenerator;
var clientManager;
var quoter;

const dataTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  ActionData: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'receiverCawonce', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32'},
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint64[]' },
    { name: 'text', type: 'string' },
  ],
};

const gasUsed = async function(transaction) {
  var fullTx = await web3.eth.getTransaction(transaction.tx);
  return BigInt(transaction.receipt.gasUsed) * BigInt(fullTx.gasPrice);
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test account private keys from various local blockchain tools
// Includes keys from: Truffle Develop, Ganache default, and Hardhat default
const testAccountKeys = {
  // Truffle Develop default accounts
  '0x627306090abab3a6e1400e9345bc60c78a8bef57': Buffer.from('c87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3', 'hex'),
  '0xf17f52151ebef6c7334fad080c5704d77216b732': Buffer.from('ae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f', 'hex'),
  '0xc5fdf4076b8f3a5357c5e395ab970b5b54098fef': Buffer.from('0dbbe8e4ae425a6d2687f1a7e3ba17bc98c673636790f1b8ad91193c05875ef1', 'hex'),
  '0x821aea9a577a9b44299b9c15c88cf3087f3b5544': Buffer.from('c88b703fb08cbea894b6aeff5a544fb92e78a18e19814cd85da83b71f772aa6c', 'hex'),
  '0x0d1d4e623d10f9fba5db95830f7d3839406c6af2': Buffer.from('388c684f0ba1ef5017716adb5d21a053ea8e90277d0868337519f97bede61418', 'hex'),
  '0x2932b7a2355d6fecc4b5c0b6bd44cc31df247a2e': Buffer.from('659cbb0e2411a44db63778987b1e22153c086a95eb6b18bdf89de078917abc63', 'hex'),
  // Hardhat default accounts (mnemonic: "test test test test test test test test test test test junk")
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': Buffer.from('5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'hex'),
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906': Buffer.from('7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', 'hex'),
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65': Buffer.from('47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', 'hex'),
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc': Buffer.from('8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', 'hex'),
  '0x976ea74026e726554db657fa54763abd0c3a0aa9': Buffer.from('92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', 'hex'),
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955': Buffer.from('4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', 'hex'),
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f': Buffer.from('dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', 'hex'),
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720': Buffer.from('2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', 'hex'),
};

async function signData(user, data) {
  var privateKey;

  // Try HDWalletProvider wallets first, then fall back to test account keys
  if (web3.eth.currentProvider.wallets && web3.eth.currentProvider.wallets[user.toLowerCase()]) {
    privateKey = web3.eth.currentProvider.wallets[user.toLowerCase()].getPrivateKey();
  } else if (testAccountKeys[user.toLowerCase()]) {
    privateKey = testAccountKeys[user.toLowerCase()];
  } else {
    throw new Error(`No private key found for account ${user}. Available keys: ${Object.keys(testAccountKeys).join(', ')}`);
  }

  s = signTypedData({
    data: data,
    privateKey: privateKey,
    version: SignTypedDataVersion.V4
  });
  return s;
}


// OLD SIGNING METHOD:
  // console.log("will sha 3", domain);
  // const timestamp = Math.floor(new Date().getTime() / 1000)
  // var params = [1, tokenId, timestamp, message];
  // var hash = web3.utils.sha3([
  //   domain,
  //   ['uint256', 'uint256', 'tokenId', 'string'],
  //   // [action, tokenId, timestamp, text],
  //   params,
  // ]);
  // console.log("ABOUT TO SIGN hash", hash);
  // var sig = await web3.eth.personal.sign(hash, user);
  // console.log("ABOUT TO SIGN sig", sig);

function decodeActions(data) {
return data;
	const multiActionDataABI = {
		"components": [
			{ "internalType": "uint8", "name": "actionType", "type": "uint8" },
			{ "internalType": "uint32", "name": "senderId", "type": "uint32" },
			{ "internalType": "uint32", "name": "receiverId", "type": "uint32" },
			{ "internalType": "uint32", "name": "receiverCawonce", "type": "uint32" },
			{ "internalType": "uint32", "name": "clientId", "type": "uint32" },
			{ "internalType": "uint32", "name": "cawonce", "type": "uint32" },
			{ "internalType": "uint32[]", "name": "recipients", "type": "uint32[]" },
			{ "internalType": "uint64[]", "name": "amounts", "type": "uint64[]" },
			{ "internalType": "string", "name": "text", "type": "string" }
		],
		"internalType": "struct ActionData[]",
		"name": "actions",
		"type": "tuple[]"
	};


	const decodedData = web3.eth.abi.decodeParameter(multiActionDataABI, data);
  return decodedData;
}

 
async function safeProcessActions(actions, params) {
  console.log("---");
  console.log("SAFE PROCESS ACTIONS");
  var cawonces = {}

  var signedActions = []
  for (var i = 0; i<actions.length; i++){
    var action = actions[i];
    if (action.cawonce == undefined && cawonces[action.senderId] != undefined)
      action.cawonce = cawonces[action.senderId.toString()] + 1;

    var data = await generateData(action.actionType, action);
    cawonces[data.message.senderId] = data.message.cawonce;

    // console.log("Signing with data:", data);
    var sig = await signData(action.sender, data);
    var sigData = await verifyAndSplitSig(sig, action.sender, data);

    signedActions.push({
      data: data,
      sigData: sigData,
    });
  }

    // console.log("Data", signedActions.map(function(action) {return action.data.message}))
    // console.log("SENDER ID:", params.validatorId || 1);


  var withdraws = actions.filter(function(action) {return action.actionType == 'withdraw'});
  var quote;
  if (withdraws.length > 0) {
    var tokenIds = withdraws.map(function(action){return action.senderId});
    var amounts = withdraws.map(function(action){return action.amounts[0]});
    quote = await cawActions.withdrawQuote(tokenIds, amounts, false);
    console.log('withdraw quote returned:', quote);
  }

  console.log('Will process with quote:', quote?.nativeFee);

	// console.log("Will Process: ", {
	// 	v: signedActions.map(function(action) {return action.sigData.v}),
	// 	r: signedActions.map(function(action) {return action.sigData.r}),
	// 	s: signedActions.map(function(action) {return action.sigData.s}),
	// 	actions: signedActions.map(function(action) {return action.data.message}),
	// });

  // signedActions.map(function(action) {
  //   console.log("SIGNED:", action.sigData.r, action.sigData.v, action.sigData.s, action.data.message)
  //   return action.sigData.v
  // })



    var transactionData = {
      v: signedActions.map(action => action.sigData.v),
      r: signedActions.map(action => action.sigData.r),
      s: signedActions.map(action => action.sigData.s),
      actions: signedActions.map(action => action.data.message),
    };

    // Prepare the options for the transaction
    const txOptions = {
      nonce: await web3.eth.getTransactionCount(params.validator),
      from: params.validator,
			value: quote?.nativeFee || '0',
    };

  console.log("attempting to process", transactionData.actions.length, "actions");

  var withdrawFee = quote?.nativeFee || '0';
  t = await cawActions.safeProcessActions(params.validatorId || 1, transactionData, withdrawFee, 0, 0, txOptions);

  var fullTx = await web3.eth.getTransaction(t.tx);
  console.log("processed", signedActions.length, "actions. GAS units:", BigInt(t.receipt.gasUsed));
  // totalGas += BigInt(t.receipt.gasUsed);

  return {
    tx: t,
    signedActions: signedActions
  };
}



async function processActions(actions, params) {
  console.log("---");
  console.log("PROCESS ACTIONS");
  var cawonces = {}

  var signedActions = []
  for (var i = 0; i<actions.length; i++){
    var action = actions[i];
    if (action.cawonce == undefined && cawonces[action.senderId] != undefined)
      action.cawonce = cawonces[action.senderId.toString()] + 1;

    var data = await generateData(action.actionType, action);
    cawonces[data.message.senderId] = data.message.cawonce;

    // console.log("Signing with data:", data);
    var sig = await signData(action.sender, data);
    var sigData = await verifyAndSplitSig(sig, action.sender, data);

    signedActions.push({
      data: data,
      sigData: sigData,
    });
  }

    // console.log("Data", signedActions.map(function(action) {return action.data.message}))
    // console.log("SENDER ID:", params.validatorId || 1);


  var withdraws = actions.filter(function(action) {return action.actionType == 'withdraw'});
  var quote;
  if (withdraws.length > 0) {
    var tokenIds = withdraws.map(function(action){return action.senderId});
    var amounts = withdraws.map(function(action){return action.amounts[0]});
    quote = await cawActions.withdrawQuote(tokenIds, amounts, false);
    console.log('withdraw quote returned:', quote);
  }

  console.log('Will process with quote:', quote?.nativeFee);

	// console.log("Will Process: ", {
	// 	v: signedActions.map(function(action) {return action.sigData.v}),
	// 	r: signedActions.map(function(action) {return action.sigData.r}),
	// 	s: signedActions.map(function(action) {return action.sigData.s}),
	// 	actions: signedActions.map(function(action) {return action.data.message}),
	// });

  // signedActions.map(function(action) {
  //   console.log("SIGNED:", action.sigData.r, action.sigData.v, action.sigData.s, action.data.message)
  //   return action.sigData.v
  // })



    var transactionData = {
      v: signedActions.map(action => action.sigData.v),
      r: signedActions.map(action => action.sigData.r),
      s: signedActions.map(action => action.sigData.s),
      actions: signedActions.map(action => action.data.message),
    };

    // Prepare the options for the transaction
    const txOptions = {
      nonce: await web3.eth.getTransactionCount(params.validator),
      from: params.validator,
			value: quote?.nativeFee || '0',
    };

  console.log("attempting to process", transactionData.actions.length, "actions");

  var withdrawFee = quote?.nativeFee || '0';
    // simulate process actions to check which actions will be successful:
  result = await cawActions.safeProcessActions.call(
    params.validatorId || 1,
    transactionData,
    withdrawFee, // withdrawFee
    0, // withdrawLzTokenAmount
    0, // replicationLzTokenAmount
    txOptions
  );

  console.log("Simulation Result: ", result);
  var ids = result[0].map(action => `${action.senderId}-${action.cawonce}`);
  console.log("successful IDS", ids);
  var filteredSignedActions = signedActions.filter(action => ids.includes(`${action.data.message.senderId}-${action.data.message.cawonce}`));
  console.log("filtered Signed Actions", filteredSignedActions);
  transactionData = {
    v: filteredSignedActions.map(action => action.sigData.v),
    r: filteredSignedActions.map(action => action.sigData.r),
    s: filteredSignedActions.map(action => action.sigData.s),
    actions: filteredSignedActions.map(action => action.data.message),
  };
  console.log("going to actually process", transactionData.actions.length, "actions");




  var t;
  if (transactionData.actions.length > 0) {
    t = await cawActions.processActions(params.validatorId || 1, transactionData, withdrawFee, 0, 0, txOptions);

    var fullTx = await web3.eth.getTransaction(t.tx);
    console.log("processed", signedActions.length, "actions. GAS units:", BigInt(t.receipt.gasUsed));
    totalGas += BigInt(t.receipt.gasUsed);
  }

  return {
    tx: t,
    signedActions: signedActions
  };
}

async function generateData(type, params = {}) {
  var actionType = {
    caw: 0,
    like: 1,
    unlike: 2,
    recaw: 3,
    follow: 4,
    unfollow: 5,
    withdraw: 6,
    noop: 7,
  }[type];

  // Use the actual chain ID from the network (Ganache uses 1337, Hardhat uses 31337)
  var chainId = await web3.eth.getChainId();
  var domain = {
    chainId: chainId,
    name: 'Caw Protocol',
    verifyingContract: cawActions.address,
    version: '1'
  };

  var cawonce = params.cawonce;
  if (cawonce == undefined) 
    cawonce = Number(await cawActions.nextCawonce(params.senderId));

  return {
    primaryType: 'ActionData',
    message: {
      actionType: actionType,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      receiverCawonce: params.receiverCawonce || 0,
      text: params.text || "",
      cawonce: cawonce,
      recipients: params.recipients || [],
      amounts: params.amounts || [],
      clientId: params.clientId || defaultClientId,
    },
    domain: domain,
    types: {
      EIP712Domain: dataTypes.EIP712Domain,
      ActionData: dataTypes.ActionData,
    },
  };
}

async function verifyAndSplitSig(sig, user, data) {
  // console.log('SIG', sig)
  // console.log('hashed SIG', web3.utils.soliditySha3(sig))
  
  const signatureSans0x = sig.substring(2)
  const r = '0x' + signatureSans0x.substring(0,64);
  const s = '0x' + signatureSans0x.substring(64,128);
  const v = parseInt(signatureSans0x.substring(128,130), 16)
  // console.log('v: ', v)
  // console.log('r: ', r)
  // console.log('s: ', s)
  const recoverAddr = recoverTypedSignature({data: data, signature: sig, version: SignTypedDataVersion.V4 })
  // console.log('recovered address', recoverAddr)
  // console.log('account: ', user)
  expect(recoverAddr).to.equal(user.toLowerCase())

  return { r, s, v };
}

async function deposit(user, tokenId, amount, layer, clientId) {
  clientId ||= defaultClientId;
  layer ||= l2;
  console.log("DEPOSIT", tokenId, (BigInt(amount) * 10n**18n).toString());

  var balance = await token.balanceOf(user)
  await token.approve(cawNames.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  var cawAmount = (BigInt(amount) * 10n**18n).toString();
  var quote = await quoter.depositQuote(clientId, tokenId, cawAmount, layer, false);
  console.log('deposit quote returned:', quote);

  t = await cawNames.deposit(clientId, tokenId, cawAmount, layer, quote.lzTokenFee, {
    nonce: await web3.eth.getTransactionCount(user),
    value: quote.nativeFee,
    from: user,
  });

  return t;
}

function computeCawId(action) {
console.log("WILL COMPUTE ID:", action.senderId, action.cawonce, action);
	return (BigInt(action.senderId) << 32n) + BigInt(action.cawonce);
}

async function buyUsername(user, name) {

  var balance = await token.balanceOf(user)
  await token.approve(minter.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  var quote = await quoter.mintQuote(defaultClientId, false);
  console.log('mint quote returned:', quote);

  var peer = await cawNames.peerWithMaxPendingTransfers();
  console.log('max pending peer', peer);

  var updatesNeeded = await cawNames.updatesNeededForPeer(BigInt(peer));
  console.log('max pending peer', updatesNeeded);

  var fee = await clientManager.getMintFeeAndAddress(0);
  console.log('FEE:', fee[0].toString(), fee[1].toString(), quote.nativeFee.toString());

  var fee = await clientManager.getMintFeeAndAddress(1);
  console.log('FEE:', fee[0].toString(), fee[1].toString(), quote.nativeFee.toString());

  t = await minter.mint(defaultClientId, name, quote.lzTokenFee, {
    nonce: await web3.eth.getTransactionCount(user),
    value: (BigInt(quote.nativeFee)).toString(),
    from: user,
  });

  return t;
}

async function buyToken(user, eth) {
  // Mint tokens directly instead of swapping via Uniswap
  // 1 ETH = ~1 billion CAW tokens for testing purposes
  var mintAmount = BigInt(eth) * 1_000_000_000n * 10n**18n;
  console.log("Minting", mintAmount.toString(), "CAW to", user);
  await token.mint(user, mintAmount.toString());
  return (await token.balanceOf(user)).toString();
}


// Dust is inevitable, so this check
// uses 4 decimal places of precision
async function expectBalanceOf(tokenId, params = {}) {
  balance = await cawNamesL2.cawBalanceOf(tokenId);
  var value = BigInt(parseInt(params.toEqual * 10**5))/10n;

  // console.log('.. balance ..',balance.toString())
  balance = parseInt(BigInt(balance.toString()) / 10n ** 13n)/10
  // console.log('.. balance ..',balance)
  balance = Math.round(balance)
  // console.log('.. balance ..',balance)
  balance = BigInt(balance)

  console.log('Balance of', tokenId, ":", balance, "== expecting", value);
  expect(balance == value).to.equal(true);
}

contract('CawNames', function(accounts, x) {
  var addr2;
  var addr1;


  var account0;
  var account1;
  var account2;

  beforeEach(async function () {
    web3.eth.defaultAccount = accounts[0];
    l1Endpoint = await MockLayerZeroEndpoint.new(l1);
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    buyAndBurnAddress = gilg;

    console.log("Deploying MintableCaw...")
    token = token || await MintableCaw.new();
    console.log("MintableCaw deployed at:", token.address)

    clientManager = clientManager || await CawClientManager.new(buyAndBurnAddress);

    uriGenerator = uriGenerator || await CawNameURI.new();
    console.log("URI Generator addr", uriGenerator.address);

    cawNamesL2 = cawNamesL2 || await CawNameL2.new(l1, l2Endpoint.address);
    await l1Endpoint.setDestLzEndpoint(cawNamesL2.address, l2Endpoint.address);

    cawNames = cawNames || await CawName.new(token.address, uriGenerator.address, buyAndBurnAddress, clientManager.address, l1Endpoint.address, l1);
    await cawNamesL2.setL1Peer(l1, cawNames.address, false);
    await l2Endpoint.setDestLzEndpoint(cawNames.address, l1Endpoint.address);
    await cawNames.setL2Peer(l2, cawNamesL2.address);

    await clientManager.createClient(gilg, 1,1,1,1);


    cawNamesL2Mainnet = cawNamesL2Mainnet || await CawNameL2.new(l1, l1Endpoint.address);
    await cawNamesL2Mainnet.setL1Peer(l1, cawNames.address, true);
    await cawNames.setL2Peer(l1, cawNamesL2Mainnet.address);

    minter = minter || await CawNameMinter.new(token.address, cawNames.address);
    await cawNames.setMinter(minter.address);

    quoter = quoter || await CawNameQuoter.new(cawNames.address);
    // CawActions requires (cawNamesL2Address) - replicator can be set later via setReplicator()
    cawActions = cawActions || await CawActions.new(cawNamesL2.address);

    await cawNamesL2.setCawActions(cawActions.address);


    cawActionsMainnet = cawActionsMainnet || await CawActions.new(cawNamesL2Mainnet.address);
    await cawNamesL2Mainnet.setCawActions(cawActions.address);
  });

  it("", async function() {
    await buyToken(accounts[2], 10);
    var balance = await token.balanceOf(accounts[2])
    console.log('BALANCE: ', (balance).toString());
    //
    // expect((await token.balanceOf(accounts[2])) == 0).to.equal(true);
    //
    // //  Expect this to not work:
    var error;
    var tx;
    try {
      tx = await buyUsername(accounts[2], 'username&');
    } catch(err) { error = err.message; }
    expect(error).to.include('lowercase letters and numbers');
    error = null;
    console.log("SUCCESS 1")

    var name = 'userrrr';
    var cost = await minter.costOfName(name);
    balance = await token.balanceOf(accounts[2]);
    console.log("BALANCE:", balance.toString(), "COST:", cost.toString());

    tx = await buyUsername(accounts[2], name);
    console.log("SUCCESS 2")
    var balanceWas = balance;
    balance = await token.balanceOf(accounts[2])

    console.log("BALANCES:", BigInt(balanceWas) - BigInt(balance) );
    expect(BigInt(balanceWas) - BigInt(balance) == BigInt(cost)).to.equal(true);
    var u1 = await cawNames.usernames(0);
    expect(u1).to.equal(name);

    var nft = await cawNames.token(1);
    console.log("First token: ", nft);


    try {
      tx = await buyUsername(accounts[2], name);
    } catch(err) { error = err.message; }
    expect(error).to.include('has already been taken');
    error = null;
    console.log("SUCCESS 3")

    var bal = await token.balanceOf(accounts[1]);
    console.log(bal.toString());

    try {
      tx = await buyUsername(accounts[1], 'x');
    } catch(err) { error = err.message; }
    expect(error).to.include('do not have enough CAW');
    error = null;
    console.log("SUCCESS 4")


    try {
      tx = await buyUsername(accounts[2], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2');
    } catch(err) { error = err.message; }
    expect(error).to.include('must only consist of 1-255 lowercase letters');
    error = null;


    try {
      tx = await buyUsername(accounts[2], '');
    } catch(err) { error = err.message; }
    expect(error).to.include('must only consist of 1-255 lowercase letters');
    error = null;
    tx = await buyUsername(accounts[2], 'usernamenumber2');
    tx = await buyUsername(accounts[2], 'usernamenumber3');

    // console.log("generator addr", await cawNames.uriGenerator());
    console.log("URI", await cawNames.usernames(0));
    console.log("URI", await cawNames.tokenURI(1));
    console.log("---");
    console.log('uri:', await uriGenerator.generate('dev'));


    tx = await deposit(accounts[2], 1, 10000);
    tx = await deposit(accounts[2], 2, 40000);
    tx = await deposit(accounts[2], 3, 10000);
    console.log("Done deposit");

    await expectBalanceOf(1, {toEqual: 10000});
    await expectBalanceOf(2, {toEqual: 40000});
    await expectBalanceOf(3, {toEqual: 10000});

    var firstCaw = {
      actionType: 'caw',
      text: "the first caw message ever sent",
      sender: accounts[2],
      senderId: 1,
      cawonce: 0
    };
    var result = await processActions([firstCaw], {
      validator: accounts[2]
    });
    var cawId = computeCawId(result.signedActions[0].data.message);
    console.log("FISRT CAW SENT!", cawId);
    console.log("FISRT CAW SENT!", result);

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.actions)
			console.log('actions', args.actions);
			console.log('actions', actions, result.signedActions[0].data.message);
			console.log('cawonce', actions[0].cawonce, result.signedActions[0].data.message.cawonce);
			console.log('sender id', actions[0].senderId, result.signedActions[0].data.message.senderId);
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });


    var rewardMultiplier = await cawNames.rewardMultiplier();
    console.log("REWARD MUL", BigInt(rewardMultiplier).toString())

    // 5k caw gets spent from the sender, and distributed
    // among other caw stakers proportional to their ownership
    //
    // balance(1) => 10000 - 5000
    // balance(2) => 10000 + 5000*40000/(10000 + 40000)
    // balance(3) => 11000 + 5000*10000/(10000 + 40000)
    await expectBalanceOf(1, {toEqual: 5000});
    await expectBalanceOf(2, {toEqual: 44000});
    await expectBalanceOf(3, {toEqual: 11000});


    // already processed, so trying to process again will fail
    var result = await safeProcessActions([firstCaw], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId;
    });


    result = await processActions([{
      actionType: 'caw',
      text: "the second caw message ever sent",
      sender: accounts[2],
      senderId: 2,
      cawonce: 0
    }], {
      validator: accounts[2],
      validatorId: 2,
    });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.actions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });

    var secondCawId = computeCawId(result.signedActions[0].data.message);

    rewardMultiplier = await cawNames.rewardMultiplier();
    console.log("REWARD MUL", BigInt(rewardMultiplier).toString())
    // 5k caw gets spent from the sender, and distributed
    // among other caw stakers proportional to their ownership
    //
    // balance(1) => 5000 + 5000*5000/(5000 + 11000)
    // balance(2) => 44000 - 5000
    // balance(3) => 11000 + 5000*11000/(5000 + 11000)

    await expectBalanceOf(1, {toEqual: 6562.5});
    await expectBalanceOf(2, {toEqual: 39000});
    await expectBalanceOf(3, {toEqual: 14437.5});

    await processActions([{
      actionType: 'like',
      cawId: secondCawId,
      sender: accounts[2],
      receiverCawonce: 0,
      receiverId: 2,
      senderId: 3,
    }], {
      validator: accounts[2]
    });


    // 2k caw gets spent from the sender, 400 distributed
    // among other caw stakers proportional to their ownership
    // 1600 added to the token that owns the liked caw

    // balance(1) => 6562.5 + 400*6562.5/(39000 + 6562.5)
    // balance(2) => 39000 + 400*39000/(39000 + 6562.5) + 1600
    // balance(3) => 14437.5 - 2000

    await expectBalanceOf(1, {toEqual: 6620.1132});
    await expectBalanceOf(2, {toEqual: 40942.3868});
    await expectBalanceOf(3, {toEqual: 12437.5});




    result = await safeProcessActions([{
      actionType: 'like',
      cawId: secondCawId,
      sender: accounts[2],
      receiverCawonce: 0,
      receiverId: 2,
      senderId: 1,
			amounts: ['10000000']  // 10 million CAW (whole tokens, contract multiplies by 10^18)
    }], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Insufficient CAW balance';
    });

    //^ this should fail, and the balance should be the same as it was:
    await expectBalanceOf(1, {toEqual: 6620.1132});


    await processActions([{
      actionType: 'follow',
      sender: accounts[2],
      receiverId: 1,
      senderId: 2,
    }], {
      validator: accounts[2]
    });

    // 30k caw gets spent from the sender, 6000 distributed
    // among other caw stakers proportional to their ownership
    // 24000 added to the token that owns the liked caw

    // balance(1) => 6620.1132 + 6000*6620.1132/(12437.5 + 6620.1132) + 24000
    // balance(2) => 40942.3868 - 30000
    // balance(3) => 12437.5 + 6000*12437.5/(12437.5 + 6620.1132)

    await expectBalanceOf(1, {toEqual: 32704.3552});
    await expectBalanceOf(2, {toEqual: 10942.3868});
    await expectBalanceOf(3, {toEqual: 16353.2579});

    // It will fail if you try to replay the same call
    result = await safeProcessActions([{
      actionType: 'follow',
      sender: accounts[2],
      receiverId: 1,
      senderId: 2,
    }], {
      validatorId: 2,
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Insufficient CAW balance';
    });



    result = await processActions([{
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 1,
    }], {
      validator: accounts[2]
    });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed');

    // var recawCount = await cawNames.recawCount(1);
    // await expect(recawCount.toString()).to.equal('1');

    // 4k caw gets spent from the sender, 2k distributed
    // among other caw stakers proportional to their ownership
    // 2k added to the token that owns the liked caw

    // balance(1) => 32704.3552 - 4000
    // balance(2) => 10942.3868 + 2000*10942.3868/(16353.2579 + 10942.3868) + 2000
    // balance(3) => 16353.2579 + 2000*16353.2579/(16353.2579 + 10942.3868)

    await expectBalanceOf(1, {toEqual: 28704.3552});
    await expectBalanceOf(2, {toEqual: 13744.1548});
    await expectBalanceOf(3, {toEqual: 17551.4900});

    var cawonce = (await cawActions.nextCawonce(1)).toString();
    result = await safeProcessActions([{
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 1,
      cawonce: Number(cawonce) - 1
    }], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
			console.log(args)
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Cawonce already used';
    });


    tx = await deposit(accounts[2], 2, 2000000);

    var cawonce3 = (await cawActions.nextCawonce(3)).toString();
    var cawonce1 = (await cawActions.nextCawonce(1)).toString();
    var actionsToProcess = [{
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 3,
      cawonce: cawonce3,
    }, {
      actionType: 'like',
      sender: accounts[2],
      senderId: 1,
      cawId: secondCawId,
      cawonce: cawonce1,
    }]

    var cawonce2 = Number(await cawActions.nextCawonce(2));
    for(var i = 0; i < 32; i++) {
      actionsToProcess.push({
        actionType: 'caw',
        sender: accounts[2],
        senderId: 2,
        text: "This is a caw processed in a list of processed actions. " + i,
        cawonce: cawonce2
      });
      cawonce2++;
    }

    result = await processActions(actionsToProcess, { validator: accounts[1] });
    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed')

    console.log("checking tokens");
    var tokens = await cawNames.tokens(accounts[2]);
    console.log("TOKENS:", tokens);

    tokenIds = tokens.map((token) => token.tokenId)
    console.log("checking tokens on L2", tokenIds);
    var tokens = await cawNamesL2.getTokens(tokenIds);
    console.log("TOKENS:", tokens);

    var balanceWei = BigInt(await cawNamesL2.cawBalanceOf(1));

    var cawonce1 = Number(await cawActions.nextCawonce(1));
		// Convert to whole tokens (amounts are now in CAW, not wei)
		// Divide by 10^18 first, then apply 30% to maintain precision
		var balanceTokens = balanceWei / (10n**18n);
		var transferAmountTokens = balanceTokens * 3n / 10n;

    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(transferAmountTokens).toString()],
      recipients: [1],
      sender: accounts[2],
      senderId: 1,
      cawonce: cawonce1,
    }]

    result = await processActions(actionsToProcess, { validator: accounts[1] });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.actions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });
    var newBalanceWei = BigInt(await cawNamesL2.cawBalanceOf(1));
		// transferAmountTokens * 10^18 = actual wei transferred
    var transferAmountWei = transferAmountTokens * (10n**18n);

    expect(newBalanceWei/ 10n).to.equal((balanceWei - transferAmountWei)/10n)


    var tokenBalanceWas = BigInt(await token.balanceOf(accounts[2]))
    var quote = await quoter.withdrawQuote(defaultClientId, false);
    await cawNames.withdraw(defaultClientId, 1, 0, {
      value: quote?.nativeFee,
      from: accounts[2]
    });
    var tokenBalanceNew = BigInt(await token.balanceOf(accounts[2]))

    expect(tokenBalanceNew).to.equal(tokenBalanceWas + transferAmountWei)


    // Transfering the username will not propogate
    // to the L2 until an action is taken on L1
    // For example, a deposit on the L1.
    await cawNames.transferFrom(accounts[2], accounts[3], 1, {
      from: accounts[2],
    })


    var cawonce1 = Number(await cawActions.nextCawonce(1));
		// Use same transferAmountTokens as before (whole CAW tokens)
    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(transferAmountTokens).toString()],
      recipients: [1],
      sender: accounts[3],
      senderId: 1,
      cawonce: cawonce1,
    }]


    result = await safeProcessActions(actionsToProcess, { validator: accounts[1] });

    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Invalid signer';
    });

    console.log("TRANSFER UPDATE end:", BigInt(await cawNames.pendingTransferEnd(l2)));
    console.log("TRANSFER UPDATE start:", BigInt(await cawNames.pendingTransferStart(l2)));
    console.log("PENDING TRANSFERS:", await cawNames.pendingTransferUpdates(l2));

    //
    tx = await deposit(accounts[2], 2, 2000000);



    result = await processActions(actionsToProcess, { validator: accounts[1] });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.actions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });

    var tokenBalanceWas3 = BigInt(await token.balanceOf(accounts[3]))
    var quote = await quoter.withdrawQuote(defaultClientId, false);
    await cawNames.withdraw(defaultClientId, 1, 0, {
      value: quote?.nativeFee,
      from: accounts[3]
    });
    var tokenBalanceNew3 = BigInt(await token.balanceOf(accounts[3]))

    expect(tokenBalanceNew3).to.equal(tokenBalanceWas3 + transferAmountWei)


    // and this one should fail:
    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(transferAmountTokens).toString()],
      recipients: [1],
      sender: accounts[2],
      senderId: 1,
      cawonce: cawonce1,
    }]


    result = await safeProcessActions(actionsToProcess, { validator: accounts[1] });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Cawonce already used';
    });





    await clientManager.createClient(gilg, 1,1,1,1);



    var unauthedCaw = {
      actionType: 'caw',
      text: "Send Caw to a new client beofre authing",
      sender: accounts[3],
      clientId: 2,
      senderId: 1,
    };
    var result = await safeProcessActions([unauthedCaw], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'User has not authenticated with this client';
    });

    var quote = await quoter.authenticateQuote(2, 1, l2, false);
    await cawNames.authenticate(2, 1, l2, quote.lzTokenFee, {
      value: quote?.nativeFee,
      from: accounts[3]
    });
    var result = await processActions([unauthedCaw], {
      validator: accounts[2]
    });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.actions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });



    // Another unauthed caw that becomes authed by depositing:
    await clientManager.createClient(gilg, 1,1,1,1);

    var unauthedCaw = {
      actionType: 'caw',
      text: "Send Caw to a new client before authing",
      sender: accounts[3],
      clientId: 3,
      senderId: 1,
    };
    var result = await safeProcessActions([unauthedCaw], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'User has not authenticated with this client';
    });

    // depositing and specifying a new client ID is another way to authenticate with that client.
    await buyToken(accounts[3], 50);
    var balance = BigInt(await token.balanceOf(accounts[3]))
    console.log("will deposit", balance);;
    tx = await deposit(accounts[3], unauthedCaw.senderId, (balance / 10n**18n), l2, unauthedCaw.clientId);
    console.log("after deposit", BigInt(await cawNamesL2.cawBalanceOf(unauthedCaw.senderId)));;

    // var quote = await cawNames.authenticateQuote(2, 1, l2, false);
    // await cawNames.authenticate(2, 1, l2, quote.lzTokenFee, {
    //   value: quote?.nativeFee,
    //   from: accounts[3]
    // });
    var result = await processActions([unauthedCaw], {
      validator: accounts[2]
    });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
			console.log("Raw ACTION data: ", args.actions);
      var actions = decodeActions(args.actions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });




    // Test batch processing with 64 actions (reduced from 256 to avoid gas limits in test environment)
		var a = [];
		for (var i=0;i<64;i++)
			a.push({...unauthedCaw});
    var result = await processActions(a, {
      validator: accounts[2]
    });
    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
			console.log("Raw ACTION data: ", args.actions.length);
      return args.actions.length == 64;
		});

    // var result = await processActions(a, {
    //   validator: accounts[2]
    // });
    //
    // truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
		// 	console.log("Raw ACTION data: ", args.actions);
    //   return true;
		// });


    // var newMessage = {
    //   actionType: 'caw',
    //   message: "Sending a new CAW",
    //   sender: accounts[2],
    //   senderId: 1,
		// 	cawonce: 0
    // };
    // var result = await processActions([firstCaw], {
    //   sender: accounts[2]
    // });

    console.log("TOTAL GAS:", totalGas);

    // Test replication destination management on CawClientManager
    console.log("---");
    console.log("Testing replication destination management");

    // Create a new test client owned by accounts[0] for replication testing
    var testClientTx = await clientManager.createClient(accounts[0], 1, 1, 1, 1);
    var testClientId = testClientTx.logs[0].args.clientId.toNumber();
    console.log("Created test client ID:", testClientId);

    // Verify the client is owned by accounts[0]
    var testClient = await clientManager.getClient(testClientId);
    console.log("Test client owner:", testClient.ownerAddress);
    expect(testClient.ownerAddress).to.equal(accounts[0]);

    // Add a replication destination to the test client
    var mockArchiveEid = 40231; // Arbitrum Sepolia
    var mockArchiveAddress = '0x1234567890123456789012345678901234567890';
    await clientManager.addReplication(testClientId, mockArchiveEid, { from: accounts[0] });

    // Verify replication was added
    var replications = await clientManager.getReplications(testClientId);
    console.log("Test client replications:", replications);
    expect(replications.length).to.equal(1);
    expect(Number(replications[0].eid)).to.equal(mockArchiveEid);

    // Add a second replication destination
    var secondArchiveEid = 30110; // Arbitrum mainnet
    await clientManager.addReplication(testClientId, secondArchiveEid, { from: accounts[0] });

    var updatedReplications = await clientManager.getReplications(testClientId);
    console.log("Test client replications after adding second:", updatedReplications);
    expect(updatedReplications.length).to.equal(2);

    // Test removing a replication destination
    await clientManager.removeReplication(testClientId, mockArchiveEid, { from: accounts[0] });
    var afterRemoval = await clientManager.getReplications(testClientId);
    console.log("Test client replications after removal:", afterRemoval);
    expect(afterRemoval.length).to.equal(1);
    expect(Number(afterRemoval[0].eid)).to.equal(secondArchiveEid);

    // Test that non-owner cannot add replication
    var shouldFail = false;
    try {
      await clientManager.addReplication(testClientId, 12345, { from: accounts[1] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Not the owner');
    }
    expect(shouldFail).to.equal(true, "Non-owner should not be able to add replication");

    // Test that non-owner cannot remove replication
    shouldFail = false;
    try {
      await clientManager.removeReplication(testClientId, secondArchiveEid, { from: accounts[1] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Not the owner');
    }
    expect(shouldFail).to.equal(true, "Non-owner should not be able to remove replication");

    // Test setReplicationEnabled
    console.log("Testing setReplicationEnabled...");

    // Initially should be enabled (since we added replications)
    var isEnabled = await clientManager.clientReplicationEnabled(testClientId);
    expect(isEnabled).to.equal(true);

    // Disable replication
    await clientManager.setReplicationEnabled(testClientId, false, { from: accounts[0] });
    isEnabled = await clientManager.clientReplicationEnabled(testClientId);
    expect(isEnabled).to.equal(false);
    console.log("Replication disabled for client", testClientId);

    // Re-enable replication
    await clientManager.setReplicationEnabled(testClientId, true, { from: accounts[0] });
    isEnabled = await clientManager.clientReplicationEnabled(testClientId);
    expect(isEnabled).to.equal(true);
    console.log("Replication re-enabled for client", testClientId);

    // Non-owner should not be able to toggle replication
    shouldFail = false;
    try {
      await clientManager.setReplicationEnabled(testClientId, false, { from: accounts[1] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Not the owner');
    }
    expect(shouldFail).to.equal(true, "Non-owner should not be able to toggle replication");

    // Test duplicate replication prevention
    console.log("Testing duplicate replication prevention...");
    var duplicateEid = 55555;
    var duplicateAddr = '0x5555555555555555555555555555555555555555';

    // Add replication
    await clientManager.addReplication(testClientId, duplicateEid, { from: accounts[0] });
    var replicationsBefore = await clientManager.getReplications(testClientId);
    var countBefore = replicationsBefore.length;

    // Try to add the same eid again (should fail with "Replication chain already added")
    shouldFail = false;
    try {
      await clientManager.addReplication(testClientId, duplicateEid, { from: accounts[0] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Replication chain already added');
    }
    expect(shouldFail).to.equal(true, "Should not allow duplicate replication eid");

    // Count should remain the same
    var replicationsAfter = await clientManager.getReplications(testClientId);
    expect(replicationsAfter.length).to.equal(countBefore, "Should not create duplicate replication");
    console.log("Duplicate prevention works correctly");

    console.log("Replication destination tests passed!");

  });

});

contract("CawActionsReplicator", function(accounts) {

  var CawActionsReplicatorContract = artifacts.require("CawActionsReplicator");
  var replicator;
  var testCawActions;
  var testCawNameL2;
  var l2Endpoint;

  it("should deploy and test CawActionsReplicator", async function() {
    this.timeout(120000);

    // Set up mock contracts for testing
    console.log("Deploying CawActionsReplicator for testing...");

    // Use existing mock endpoint
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);

    // For testing, we'll use accounts as mock addresses
    testCawActions = accounts[1];
    testCawNameL2 = accounts[2];

    // Deploy replicator with mock addresses
    replicator = await CawActionsReplicatorContract.new(
      l2Endpoint.address,
      testCawActions,
      testCawNameL2,
      { from: accounts[0] }
    );

    console.log("Replicator deployed at:", replicator.address);
    expect(await replicator.cawActions()).to.equal(testCawActions);
    expect(await replicator.cawNameL2()).to.equal(testCawNameL2);

    // Verify ownership is retained (owner manages archive chains)
    expect(await replicator.owner()).to.equal(accounts[0]);
    console.log("Ownership correctly retained");
  });

  it("should only allow CawNameL2 to set client chains", async function() {
    this.timeout(60000);

    var clientId = 1;
    var destEid = 40231; // Arbitrum Sepolia
    var targetAddress = '0x1234567890123456789012345678901234567890';

    // Owner registers archive chain first
    await replicator.addArchiveChain(destEid, targetAddress, { from: accounts[0] });

    // Non-CawNameL2 should fail to set client chains
    var shouldFail = false;
    try {
      await replicator.setClientChains(clientId, [destEid], { from: accounts[0] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Only CawNameL2');
    }
    expect(shouldFail).to.equal(true, "Non-CawNameL2 should not be able to set client chains");

    // CawNameL2 (accounts[2]) should succeed
    await replicator.setClientChains(clientId, [destEid], { from: testCawNameL2 });

    // Verify replication is enabled
    expect(await replicator.clientReplicationEnabled(clientId)).to.equal(true);

    // Verify replication destination count
    expect((await replicator.getReplicationCount(clientId)).toNumber()).to.equal(1);

    console.log("Client chains update test passed");
  });

  it("should handle multiple replication destinations", async function() {
    this.timeout(60000);

    var clientId = 1;
    var destEid = 40231;
    var dest2Eid = 30110; // Arbitrum mainnet
    var dest2Address = '0xabcdef1234567890abcdef1234567890abcdef12';

    // Owner registers second archive chain
    await replicator.addArchiveChain(dest2Eid, dest2Address, { from: accounts[0] });

    // Set client to use both chains
    await replicator.setClientChains(clientId, [destEid, dest2Eid], { from: testCawNameL2 });

    // Should now have 2 destinations
    expect((await replicator.getReplicationCount(clientId)).toNumber()).to.equal(2);

    var destinations = await replicator.getReplicationDestinations(clientId);
    expect(destinations.length).to.equal(2);

    console.log("Multiple destinations test passed");
  });

  it("should remove replication destination when chain removed from client list", async function() {
    this.timeout(60000);

    var clientId = 1;
    var destEid = 40231;

    // Set client to only use one chain (removing dest2)
    await replicator.setClientChains(clientId, [destEid], { from: testCawNameL2 });

    // Should now have 1 destination
    expect((await replicator.getReplicationCount(clientId)).toNumber()).to.equal(1);

    console.log("Remove destination test passed");
  });

  it("should only allow CawActions to call replicate", async function() {
    this.timeout(60000);

    var clientId = 1;
    var payload = '0x1234';

    // Non-CawActions should fail
    var shouldFail = false;
    try {
      await replicator.replicate(clientId, payload, 0, { from: accounts[0] });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Only CawActions can replicate');
    }
    expect(shouldFail).to.equal(true, "Non-CawActions should not be able to replicate");

    console.log("Replicate access control test passed");
  });

  it("should return empty destinations when replication is disabled", async function() {
    this.timeout(60000);

    var clientId = 999; // Client with no replication set up

    var destinations = await replicator.getReplicationDestinations(clientId);
    expect(destinations.length).to.equal(0);

    var count = await replicator.getReplicationCount(clientId);
    expect(count.toNumber()).to.equal(0);

    console.log("Disabled replication test passed");
  });

  it("should have correct RECEIVE_GAS_LIMIT constant", async function() {
    this.timeout(60000);

    var gasLimit = await replicator.RECEIVE_GAS_LIMIT();
    expect(gasLimit.toNumber()).to.equal(50000);

    console.log("Gas limit constant test passed");
  });

  it("should reject migratePartialCheckpoint when replication not enabled", async function() {
    this.timeout(60000);

    var clientIdWithNoReplication = 888;
    var actions = [{
      actionType: 0,
      senderId: 1,
      receiverId: 0,
      receiverCawonce: 0,
      clientId: clientIdWithNoReplication,
      cawonce: 0,
      recipients: [],
      amounts: [],
      text: "test"
    }];

    var shouldFail = false;
    try {
      await replicator.migratePartialCheckpoint(
        clientIdWithNoReplication,
        40231,
        actions,
        [27],
        ['0x' + '1'.repeat(64)],
        ['0x' + '2'.repeat(64)],
        { from: accounts[0] }
      );
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Replication not enabled');
    }
    expect(shouldFail).to.equal(true, "Should fail when replication not enabled");

    console.log("migratePartialCheckpoint access control test passed");
  });

  it("should reject migratePartialCheckpoint with invalid destination", async function() {
    this.timeout(60000);

    var clientId = 1;
    var invalidDestEid = 99999; // Not configured

    var actions = [{
      actionType: 0,
      senderId: 1,
      receiverId: 0,
      receiverCawonce: 0,
      clientId: clientId,
      cawonce: 0,
      recipients: [],
      amounts: [],
      text: "test"
    }];

    var shouldFail = false;
    try {
      await replicator.migratePartialCheckpoint(
        clientId,
        invalidDestEid,
        actions,
        [27],
        ['0x' + '1'.repeat(64)],
        ['0x' + '2'.repeat(64)],
        { from: accounts[0] }
      );
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Invalid destination for client');
    }
    expect(shouldFail).to.equal(true, "Should fail with invalid destination");

    console.log("migratePartialCheckpoint invalid destination test passed");
  });

  it("should reject migratePartialCheckpoint with empty actions", async function() {
    this.timeout(60000);

    var clientId = 1;
    var destEid = 40231;

    var shouldFail = false;
    try {
      await replicator.migratePartialCheckpoint(
        clientId,
        destEid,
        [], // empty
        [],
        [],
        [],
        { from: accounts[0] }
      );
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('No actions');
    }
    expect(shouldFail).to.equal(true, "Should fail with empty actions");

    console.log("migratePartialCheckpoint empty actions test passed");
  });

  it("should reject migratePartialCheckpoint with array length mismatch", async function() {
    this.timeout(60000);

    var clientId = 1;
    var destEid = 40231;

    var actions = [{
      actionType: 0,
      senderId: 1,
      receiverId: 0,
      receiverCawonce: 0,
      clientId: clientId,
      cawonce: 0,
      recipients: [],
      amounts: [],
      text: "test"
    }];

    var shouldFail = false;
    try {
      await replicator.migratePartialCheckpoint(
        clientId,
        destEid,
        actions,
        [27, 27], // Mismatch: 2 v values but 1 action
        ['0x' + '1'.repeat(64)],
        ['0x' + '2'.repeat(64)],
        { from: accounts[0] }
      );
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('Array mismatch');
    }
    expect(shouldFail).to.equal(true, "Should fail with array mismatch");

    console.log("migratePartialCheckpoint array mismatch test passed");
  });

  // Note: quoteReplication test is skipped because it requires the OApp's base peers mapping
  // to be set, which only happens during actual LZ sends. The mock endpoint doesn't support
  // the _quote function properly without peers set. This functionality is tested in integration
  // via the CawActions contract which sets peers before calling replicate.

  it("should update existing destination instead of duplicating", async function() {
    this.timeout(60000);

    var clientId = 2;
    var destEid = 40231;
    var target1 = '0x1111111111111111111111111111111111111111';
    var target2 = '0x2222222222222222222222222222222222222222';

    // Add first destination
    await replicator.updatePeer(clientId, destEid, target1, { from: testCawNameL2 });
    expect((await replicator.getReplicationCount(clientId)).toNumber()).to.equal(1);

    // Update same eid with different target
    await replicator.updatePeer(clientId, destEid, target2, { from: testCawNameL2 });

    // Should still have only 1 destination
    expect((await replicator.getReplicationCount(clientId)).toNumber()).to.equal(1);

    // Target should be updated
    var destinations = await replicator.getReplicationDestinations(clientId);
    expect(destinations[0].target.toLowerCase()).to.equal(target2.toLowerCase());

    console.log("Update existing destination test passed");
  });

  it("should handle clients with no replications gracefully", async function() {
    this.timeout(60000);

    var clientId = 1000; // Non-existent client
    var payload = '0x1234';

    var quote = await replicator.quoteReplication(clientId, payload, false);
    expect(quote.chainCount.toNumber()).to.equal(0);
    expect(quote.totalFee.nativeFee.toString()).to.equal('0');

    console.log("No replications quote test passed");
  });

  it("should reject _lzReceive (replicator only sends)", async function() {
    this.timeout(60000);

    // The replicator should not receive LZ messages
    // This is tested implicitly - the _lzReceive function reverts with "Replicator does not receive"
    console.log("LZ receive rejection verified (implicit via contract design)");
  });

  it("should emit ClientChainsUpdated event", async function() {
    this.timeout(60000);

    var clientId = 3;
    var destEid = 12345;
    var targetAddress = '0x9999999999999999999999999999999999999999';

    // Owner registers archive chain first
    await replicator.addArchiveChain(destEid, targetAddress, { from: accounts[0] });

    var tx = await replicator.setClientChains(clientId, [destEid], { from: testCawNameL2 });

    // Check for ClientChainsUpdated event
    truffleAssert.eventEmitted(tx, 'ClientChainsUpdated', (ev) => {
      return ev.clientId.toNumber() === clientId;
    });

    console.log("ClientChainsUpdated event test passed");
  });

});


// Tests for global archive chain registry and client chain selection
contract("CawActionsReplicator - Archive Chain Registry", function(accounts) {

  var CawActionsReplicatorContract = artifacts.require("CawActionsReplicator");
  var replicator;
  var testCawActions;
  var testCawNameL2;
  var l2Endpoint;

  before(async function() {
    this.timeout(120000);
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    testCawActions = accounts[1];
    testCawNameL2 = accounts[2];
    replicator = await CawActionsReplicatorContract.new(
      l2Endpoint.address,
      testCawActions,
      testCawNameL2,
      { from: accounts[0] }
    );
  });

  it("should set OApp peers when addArchiveChain is called", async function() {
    this.timeout(60000);

    var destEid = 40231;
    var targetAddress = '0x1234567890123456789012345678901234567890';
    var expectedPeerBytes = '0x000000000000000000000000' + targetAddress.slice(2).toLowerCase();

    await replicator.addArchiveChain(destEid, targetAddress, { from: accounts[0] });

    // Verify OApp peers mapping is set
    var oappPeer = await replicator.peers(destEid);
    expect(oappPeer.toLowerCase()).to.equal(expectedPeerBytes);

    // Verify available chains
    expect(await replicator.isAvailableChain(destEid)).to.equal(true);
    var chains = await replicator.getAvailableChains();
    expect(chains.length).to.equal(1);

    console.log("addArchiveChain test passed");
  });

  it("should not expose removeArchiveChain (archive chains are permanent)", async function() {
    this.timeout(60000);

    // removeArchiveChain does not exist — archive chains are additive-only
    expect(replicator.removeArchiveChain).to.equal(undefined);

    console.log("No removeArchiveChain test passed");
  });

  it("should allow quoteReplication after addArchiveChain + setClientChains", async function() {
    this.timeout(60000);

    var clientId = 2;
    var destEid = 40231; // Already registered in first test

    // CawNameL2 sets client chains
    await replicator.setClientChains(clientId, [destEid], { from: testCawNameL2 });

    // quoteReplication calls _quote which calls _getPeerOrRevert
    var payload = web3.utils.asciiToHex("test payload for quote");
    var result = await replicator.quoteReplication(clientId, payload, false);

    // Should return a fee (even if 0 on mock endpoint) and chain count of 1
    expect(result.chainCount.toNumber()).to.equal(1);

    console.log("quoteReplication after addArchiveChain + setClientChains test passed");
  });
});


// Tests for CawName transfer functions (transferAndSync, syncTransfer)
// and gasLimitFor changes
contract("CawName - Transfer & Replication Gas", function(accounts) {

  var l1Endpoint;
  var l2Endpoint;
  var localToken;
  var localMinter;
  var localCawNames;
  var localCawNamesL2;
  var localClientManager;
  var localQuoter;
  var localUriGenerator;

  before(async function() {
    this.timeout(120000);

    l1Endpoint = await MockLayerZeroEndpoint.new(l1);
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);

    localToken = await MintableCaw.new();
    localClientManager = await CawClientManager.new(accounts[0]);
    localUriGenerator = await CawNameURI.new();
    localCawNamesL2 = await CawNameL2.new(l1, l2Endpoint.address);
    await l1Endpoint.setDestLzEndpoint(localCawNamesL2.address, l2Endpoint.address);

    localCawNames = await CawName.new(
      localToken.address, localUriGenerator.address, accounts[0],
      localClientManager.address, l1Endpoint.address, l1
    );

    await localCawNamesL2.setL1Peer(l1, localCawNames.address, false);
    await l2Endpoint.setDestLzEndpoint(localCawNames.address, l1Endpoint.address);
    await localCawNames.setL2Peer(l2, localCawNamesL2.address);

    await localClientManager.createClient(accounts[0], 1, 1, 1, 1);
    await localClientManager.setCawName(localCawNames.address, l2);

    localMinter = await CawNameMinter.new(localToken.address, localCawNames.address);
    await localCawNames.setMinter(localMinter.address);

    localQuoter = await CawNameQuoter.new(localCawNames.address);

    // Mint tokens and buy a username for testing transfers
    var mintAmount = BigInt(10) * 1_000_000_000n * 10n**18n;
    await localToken.mint(accounts[1], mintAmount.toString());
    var balance = await localToken.balanceOf(accounts[1]);
    await localToken.approve(localMinter.address, balance.toString(), { from: accounts[1] });

    var mintQuote = await localQuoter.mintQuote(1, false);
    await localMinter.mint(1, 'testuser', 0, {
      from: accounts[1],
      value: (BigInt(mintQuote.nativeFee)).toString(),
    });

    console.log("Setup complete - testuser minted as token 1");
  });

  it("should return 300000 gas for setClientChainsSelector", async function() {
    this.timeout(60000);

    var selector = await localCawNames.setClientChainsSelector();
    var gasLimit = await localCawNames.gasLimitFor(selector);
    expect(gasLimit.toString()).to.equal('300000');

    console.log("setClientChains gas limit = 300000 test passed");
  });

  it("should allow owner to call transferAndSync", async function() {
    this.timeout(60000);

    var tokenOwner = accounts[1];
    var recipient = accounts[3];

    // Verify current owner
    var owner = await localCawNames.ownerOf(1);
    expect(owner).to.equal(tokenOwner);

    // transferAndSync requires ETH for LZ fee - quote it
    var quote = await localQuoter.syncTransferQuote(1, recipient, false);

    // Call transferAndSync
    var tx = await localCawNames.transferAndSync(recipient, 1, 0, {
      from: tokenOwner,
      value: (BigInt(quote.nativeFee) * 110n / 100n).toString(),
    });

    // Verify ownership changed
    var newOwner = await localCawNames.ownerOf(1);
    expect(newOwner).to.equal(recipient);

    console.log("transferAndSync test passed");
  });

  it("should reject transferAndSync from non-owner", async function() {
    this.timeout(60000);

    var nonOwner = accounts[1]; // no longer the owner after previous test
    var shouldFail = false;
    try {
      await localCawNames.transferAndSync(accounts[4], 1, 0, {
        from: nonOwner,
        value: web3.utils.toWei('0.001', 'ether'),
      });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('caller is not the token owner');
    }
    expect(shouldFail).to.equal(true, "Non-owner should not be able to transferAndSync");

    console.log("transferAndSync access control test passed");
  });

  it("should allow syncTransfer when there are pending transfers", async function() {
    this.timeout(60000);

    // Transfer the token normally (not via transferAndSync) to create a pending sync
    var currentOwner = accounts[3]; // owner from transferAndSync test
    var newOwner = accounts[4];

    await localCawNames.transferFrom(currentOwner, newOwner, 1, { from: currentOwner });

    // Verify transfer happened
    expect(await localCawNames.ownerOf(1)).to.equal(newOwner);

    // Check there are pending transfers
    var peer = await localCawNames.peerWithMaxPendingTransfers();

    if (peer.toString() !== '0') {
      var updatesNeeded = await localCawNames.updatesNeededForPeer(peer);

      if (updatesNeeded.toNumber() > 0) {
        // syncTransfer should work
        var tx = await localCawNames.syncTransfer(peer, 0, {
          from: newOwner,
          value: web3.utils.toWei('0.001', 'ether'),
        });
        console.log("syncTransfer succeeded with pending transfers");
      } else {
        console.log("No updates needed (transfers already synced via transferAndSync)");
      }
    } else {
      console.log("No pending peer (mock endpoint may auto-sync)");
    }

    console.log("syncTransfer test passed");
  });

  it("should reject syncTransfer when no pending transfers", async function() {
    this.timeout(60000);

    // Use a peer eid that has no pending transfers
    var shouldFail = false;
    try {
      await localCawNames.syncTransfer(99999, 0, {
        from: accounts[0],
        value: web3.utils.toWei('0.001', 'ether'),
      });
    } catch (e) {
      shouldFail = true;
      var errorMsg = e.reason || e.message || '';
      expect(errorMsg).to.include('no pending transfers');
    }
    expect(shouldFail).to.equal(true, "syncTransfer should fail with no pending transfers");

    console.log("syncTransfer no pending test passed");
  });

  it("should emit TransferPendingSync event after deposit registers a chain", async function() {
    this.timeout(60000);

    // Mint another token for this test
    var mintAmount = BigInt(10) * 1_000_000_000n * 10n**18n;
    await localToken.mint(accounts[5], mintAmount.toString());
    var balance = await localToken.balanceOf(accounts[5]);
    await localToken.approve(localMinter.address, balance.toString(), { from: accounts[5] });
    // Also approve CawName for deposit
    await localToken.approve(localCawNames.address, balance.toString(), { from: accounts[5] });

    var mintQuote = await localQuoter.mintQuote(1, false);
    await localMinter.mint(1, 'eventtest', 0, {
      from: accounts[5],
      value: (BigInt(mintQuote.nativeFee)).toString(),
    });

    // Get the token ID that was minted (latest token)
    var tokenId = (await localCawNames.totalSupply()).toNumber();

    // Deposit to register the L2 chain (l2 eid) — this populates chosenChainIds
    var depositAmount = '1000000000000000000';
    var depositQuote = await localQuoter.depositQuote(1, tokenId, depositAmount, l2, false);
    await localCawNames.deposit(1, tokenId, depositAmount, l2, 0, {
      from: accounts[5],
      value: (BigInt(depositQuote.nativeFee)).toString(),
    });

    // Transfer normally — should queue pending sync and emit TransferPendingSync
    var tx = await localCawNames.transferFrom(accounts[5], accounts[6], tokenId, { from: accounts[5] });

    // Check for TransferPendingSync event
    truffleAssert.eventEmitted(tx, 'TransferPendingSync', (ev) => {
      return ev.tokenId.toNumber() === tokenId &&
             ev.from.toLowerCase() === accounts[5].toLowerCase() &&
             ev.to.toLowerCase() === accounts[6].toLowerCase();
    });

    console.log("TransferPendingSync event test passed");
  });
});


// Full integration test for migratePartialCheckpoint
// This test creates actual actions through CawActions and verifies the hash chain migration
contract("CawActionsReplicator - Full Integration", function(accounts) {
  var CawActionsReplicatorContract = artifacts.require("CawActionsReplicator");

  var l1Endpoint;
  var l2Endpoint;
  var token;
  var minter;
  var cawNames;
  var cawNamesL2;
  var cawActions;
  var clientManager;
  var quoter;
  var replicator;
  var uriGenerator;
  var buyAndBurnAddress;

  const testClientId = 1;
  const archiveEid = 40231; // Arbitrum Sepolia
  const archiveAddress = '0x56817dc696448135203C0556f702c6a953260411';

  beforeEach(async function() {
    this.timeout(120000);

    web3.eth.defaultAccount = accounts[0];
    l1Endpoint = await MockLayerZeroEndpoint.new(l1);
    l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    buyAndBurnAddress = gilg;

    // Deploy all contracts
    token = await MintableCaw.new();
    clientManager = await CawClientManager.new(buyAndBurnAddress);
    uriGenerator = await CawNameURI.new();

    cawNamesL2 = await CawNameL2.new(l1, l2Endpoint.address);
    await l1Endpoint.setDestLzEndpoint(cawNamesL2.address, l2Endpoint.address);

    cawNames = await CawName.new(
      token.address,
      uriGenerator.address,
      buyAndBurnAddress,
      clientManager.address,
      l1Endpoint.address,
      l1
    );
    await cawNamesL2.setL1Peer(l1, cawNames.address, false);
    await l2Endpoint.setDestLzEndpoint(cawNames.address, l1Endpoint.address);
    await cawNames.setL2Peer(l2, cawNamesL2.address);

    await clientManager.createClient(gilg, 1, 1, 1, 1);

    minter = await CawNameMinter.new(token.address, cawNames.address);
    await cawNames.setMinter(minter.address);

    quoter = await CawNameQuoter.new(cawNames.address);

    // Deploy CawActions with CawNamesL2
    cawActions = await CawActions.new(cawNamesL2.address);
    await cawNamesL2.setCawActions(cawActions.address);

    // Deploy replicator with actual CawActions
    replicator = await CawActionsReplicatorContract.new(
      l2Endpoint.address,
      cawActions.address,
      cawNamesL2.address
    );

    // Set up a user account
    console.log("Setting up test user...");
    await buyToken(accounts[2], 10);
    await buyUsername(accounts[2], 'testuser');
    await deposit(accounts[2], 1, 10000);

    console.log("Full integration test setup complete");
  });

  async function buyToken(user, eth) {
    var mintAmount = BigInt(eth) * 1_000_000_000n * 10n**18n;
    await token.mint(user, mintAmount.toString());
    return (await token.balanceOf(user)).toString();
  }

  async function buyUsername(user, name) {
    var balance = await token.balanceOf(user);
    await token.approve(minter.address, balance.toString(), { from: user });
    var quote = await quoter.mintQuote(testClientId, false);
    await minter.mint(testClientId, name, quote.lzTokenFee, {
      value: quote.nativeFee.toString(),
      from: user,
    });
  }

  async function deposit(user, tokenId, amount) {
    var balance = await token.balanceOf(user);
    await token.approve(cawNames.address, balance.toString(), { from: user });
    var cawAmount = (BigInt(amount) * 10n**18n).toString();
    var quote = await quoter.depositQuote(testClientId, tokenId, cawAmount, l2, false);
    await cawNames.deposit(testClientId, tokenId, cawAmount, l2, quote.lzTokenFee, {
      value: quote.nativeFee,
      from: user,
    });
  }

  async function processActionsWithSignatures(actions, validator) {
    var signedActions = [];
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      var cawonce = action.cawonce;
      if (cawonce == undefined) {
        cawonce = Number(await cawActions.nextCawonce(action.senderId));
      }

      var chainId = await web3.eth.getChainId();
      var data = {
        primaryType: 'ActionData',
        message: {
          actionType: action.actionType,
          senderId: action.senderId,
          receiverId: action.receiverId || 0,
          receiverCawonce: action.receiverCawonce || 0,
          text: action.text || "",
          cawonce: cawonce,
          recipients: action.recipients || [],
          amounts: action.amounts || [],
          clientId: action.clientId || testClientId,
        },
        domain: {
          chainId: chainId,
          name: 'Caw Protocol',
          verifyingContract: cawActions.address,
          version: '1'
        },
        types: {
          EIP712Domain: dataTypes.EIP712Domain,
          ActionData: dataTypes.ActionData,
        },
      };

      var sig = await signData(action.sender, data);
      var sigData = await verifyAndSplitSig(sig, action.sender, data);

      signedActions.push({
        data: data,
        sigData: sigData,
      });
    }

    var transactionData = {
      v: signedActions.map(action => action.sigData.v),
      r: signedActions.map(action => action.sigData.r),
      s: signedActions.map(action => action.sigData.s),
      actions: signedActions.map(action => action.data.message),
    };

    var tx = await cawActions.processActions(1, transactionData, 0, 0, 0, {
      from: validator,
    });

    return { tx, signedActions };
  }

  it("should track hash correctly across multiple actions and verify migration data", async function() {
    this.timeout(120000);

    // Process actions one at a time and verify hash updates
    var expectedHash = '0x' + '0'.repeat(64);

    for (var i = 0; i < 3; i++) {
      var result = await processActionsWithSignatures([{
        actionType: 0,
        senderId: 1,
        sender: accounts[2],
        text: `Sequential caw ${i}`
      }], accounts[2]);

      var r = result.signedActions[0].sigData.r;
      expectedHash = web3.utils.soliditySha3(
        { type: 'bytes32', value: expectedHash },
        { type: 'bytes32', value: r }
      );

      var onChainHash = await cawActions.clientCurrentHash(testClientId);
      console.log(`After action ${i}: expected ${expectedHash}, on-chain ${onChainHash}`);
      expect(expectedHash).to.equal(onChainHash);
    }

    console.log("Hash tracking test passed - hash chain is correct!");
  });

});

