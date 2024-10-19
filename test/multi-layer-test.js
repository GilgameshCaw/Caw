const IERC20 = artifacts.require("IERC20");
const CawNameURI = artifacts.require("CawNameURI");
const CawClientManager = artifacts.require("CawClientManager");
const CawName = artifacts.require("CawName");
const CawNameL2 = artifacts.require("CawNameL2");
const CawNameMinter = artifacts.require("CawNameMinter");
const CawActions = artifacts.require("CawActions");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const ISwapper = artifacts.require("ISwapRouter");
// const ethereumjs = require("ethereumjs-util");

const truffleAssert = require('truffle-assertions');


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


const wethAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const cawAddress = '0xf3b9569f82b18aef890de263b84189bd33ebe452'; // CAW
const usdcAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // USDC

const l2 = 8453;
const l1 = 30101;
var defaultClientId = 1;
var token;
var minter;
var swapper;
var cawNames;
var buyAndBurnAddress;
var cawNamesL2;
var cawNamesL2Mainnet;

var cawActions;
var cawActionsMainnet;

var uriGenerator;
var clientManager;
var totalGas = 0n;

const dataTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  CawAction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'receiverCawonce', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint128[]' },
    { name: 'text', type: 'string' },
  ],
  CawInteraction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'receiverCawonce', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint128[]' },
  ],
  UserInteraction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint128[]' },
  ],
  WithdrawAction: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'clientId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint128[]' },
  ],
};



const gasUsed = async function(transaction) {
  var fullTx = await web3.eth.getTransaction(transaction.tx);
  return BigInt(transaction.receipt.gasUsed) * BigInt(fullTx.gasPrice);
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function signData(user, data) {
  var privateKey = web3.eth.currentProvider.wallets[user.toLowerCase()].getPrivateKey()
  console.log("SIgning:::", data, privateKey);
  s = signTypedData({
    data: data,
    privateKey: privateKey,
    version: SignTypedDataVersion.V4
  });
  console.log("SIG:", s)
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
			{ "internalType": "uint128[]", "name": "amounts", "type": "uint128[]" },
			{ "internalType": "string", "name": "text", "type": "string" }
		],
		"internalType": "struct ActionData[]",
		"name": "actions",
		"type": "tuple[]"
	};


	const decodedData = web3.eth.abi.decodeParameter(multiActionDataABI, data);
  return decodedData;
}

 



async function processActions(actions, params) {
  console.log("---");
  console.log("PROCESS ACTIONS");
  const cawonces = {};

  const cawActionsArray = [];
  const cawInteractionsArray = [];
  const userInteractionsArray = [];
  const withdrawActionsArray = [];

	const signedActions = [];

  for (const action of actions) {
    if (action.cawonce == undefined && cawonces[action.senderId] != undefined)
      action.cawonce = cawonces[action.senderId.toString()] + 1;

    var data = await generateData(action.actionType, action);
    cawonces[data.message.senderId] = data.message.cawonce;

    const sig = await signData(action.sender, data);
    const sigData = await verifyAndSplitSig(sig, action.sender, data);

    // Combine message and signature data
    const actionData = {
      ...data.message,
      // actionType: data.message.actionType,
      v: sigData.v,
      r: sigData.r,
      s: sigData.s,
    };

		console.log("ACTION DATA:", actionData);

    // Push to the appropriate action array
    if (action.actionType === 'caw') {
      cawActionsArray.push(actionData);
    } else if (['like', 'unlike', 'recaw'].includes(action.actionType)) {
      cawInteractionsArray.push(actionData);
    } else if (['follow', 'unfollow'].includes(action.actionType)) {
      userInteractionsArray.push(actionData);
    } else if (['withdraw', 'noop'].includes(action.actionType)) {
      withdrawActionsArray.push(actionData);
    }

    signedActions.push({
      data: data,
      sigData: sigData,
    });
  }

  var quote;
  if (withdrawActionsArray.length > 0) {
    var tokenIds = withdrawActionsArray.map(function(action){return action.senderId});
    var amounts = withdrawActionsArray.map(function(action){return action.amounts[0]});
    quote = await cawActions.withdrawQuote(tokenIds, amounts, false);
    console.log('withdraw quote returned:', quote);
  }

  // Prepare parameters for the `processActions` function call
  const validatorId = params.validatorId || 1;

  // Call the `processActions` function on the `cawActions` contract instance
  const t = await cawActions.processActions(
    validatorId,
    cawActionsArray,
    cawInteractionsArray,
    userInteractionsArray,
    withdrawActionsArray,
    0, {
      nonce: await web3.eth.getTransactionCount(params.validator),
      from: params.validator,
      value: quote?.nativeFee || '0',
    }
  );

  console.log(`Processed ${actions.length} actions. Gas used: ${BigInt(t.receipt.gasUsed)}`);
  totalGas += BigInt(t.receipt.gasUsed);


  // Optionally, capture events emitted
  const events = t.logs;

  return {
    tx: t,
    signedActions: signedActions,
    events: events,
  };
}


async function generateData(type, params = {}) {
  const actionTypeMap = {
    caw: 0,
    like: 1,
    unlike: 2,
    recaw: 3,
    follow: 4,
    unfollow: 5,
    withdraw: 6,
    noop: 7,
  };

  const actionType = actionTypeMap[type];
  const domain = {
    chainId: await web3.eth.getChainId(),
    name: 'CawNet',
    verifyingContract: cawActions.address,
    version: '1',
  };

console.log("domaiin:", domain);

  var cawonce = params.cawonce;
  if (cawonce == undefined) 
    cawonce = Number(await cawActions.nextCawonce(params.senderId));

  let message;
  let primaryType;
  let types;

  if (type === 'caw') {
    message = {
      actionType: actionType,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      receiverCawonce: params.receiverCawonce || 0,
      clientId: params.clientId || defaultClientId,
      cawonce: cawonce,
      recipients: params.recipients || [],
      amounts: params.amounts || [],
      text: params.text || '',
    };
    primaryType = 'CawAction';
    types = {
      EIP712Domain: dataTypes.EIP712Domain,
      CawAction: dataTypes.CawAction,
    };
  } else if (['like', 'unlike', 'recaw'].includes(type)) {
    message = {
      actionType: actionType,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      receiverCawonce: params.receiverCawonce || 0,
      clientId: params.clientId || defaultClientId,
      cawonce: cawonce,
      recipients: params.recipients || [],
      amounts: params.amounts || [],
    };
    primaryType = 'CawInteraction';
    types = {
      EIP712Domain: dataTypes.EIP712Domain,
      CawInteraction: dataTypes.CawInteraction,
    };
  } else if (['follow', 'unfollow'].includes(type)) {
    message = {
      actionType: actionType,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      clientId: params.clientId || defaultClientId,
      cawonce: cawonce,
      recipients: params.recipients || [],
      amounts: params.amounts || [],
    };
    primaryType = 'UserInteraction';
    types = {
      EIP712Domain: dataTypes.EIP712Domain,
      UserInteraction: dataTypes.UserInteraction,
    };
  } else if (['withdraw', 'noop'].includes(type)) {
    message = {
      actionType: actionType,
      senderId: params.senderId,
      clientId: params.clientId || defaultClientId,
      cawonce: cawonce,
      recipients: params.recipients || [],
      amounts: params.amounts || [],
    };
    primaryType = 'WithdrawAction';
    types = {
      EIP712Domain: dataTypes.EIP712Domain,
      WithdrawAction: dataTypes.WithdrawAction,
    };
  } else {
    throw new Error(`Unsupported action type: ${type}`);
  }
  // Handle other action types similarly

  return {
    primaryType: primaryType,
    message: message,
    domain: domain,
    types: types,
  };

  // return {
  //   primaryType: 'ActionData',
  //   message: {
  //     actionType: actionType,
  //     senderId: params.senderId,
  //     receiverId: params.receiverId || 0,
  //     receiverCawonce: params.receiverCawonce || 0,
  //     text: params.text || "",
  //     cawonce: cawonce,
  //     recipients: params.recipients || [],
  //     amounts: params.amounts || [],
  //     clientId: params.clientId || defaultClientId,
  //   },
  //   domain: domain,
  //   types: {
  //     EIP712Domain: dataTypes.EIP712Domain,
  //     ActionData: dataTypes.ActionData,
  //   },
  // };
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
  var quote = await cawNames.depositQuote(clientId, tokenId, cawAmount, layer, false);
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

  var quote = await cawNames.mintQuote(defaultClientId, false);
  console.log('mint quote returned:', quote);

  t = await minter.mint(defaultClientId, name, quote.lzTokenFee, {
    nonce: await web3.eth.getTransactionCount(user),
    value: (BigInt(quote.nativeFee)).toString(),
    from: user,
  });

  return t;
}

async function buyToken(user, eth) {
  console.log("TOKEN:", token.address, swapper.address);
  t = await swapper.getAmountsOut(
    BigInt(eth * 10**18),[
    wethAddress,
    token.address,
  ]);
  console.log("TTTTT", t.toString());

  t = await swapper.swapExactETHForTokens('0',[
    wethAddress,
    token.address,
  ], user, Date.now() + 1000000, {
    nonce: await web3.eth.getTransactionCount(user),
    value: BigInt(eth * 10**18).toString(),
    from: user,
  });

  t = await swapper.getAmountsOut(
    '100000000000000000',[
    wethAddress,
    usdcAddress,
    token.address,
  ]);
  console.log("TTTTT", t.toString());

  return  (await token.balanceOf(user)).toString();
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
    buyAndBurnAddress = accounts[0];

    token = token || await IERC20.at(cawAddress);
    swapper = await ISwapper.at('0x7a250d5630b4cf539739df2c5dacb4c659f2488d'); // uniswap

    clientManager = clientManager || await CawClientManager.new(buyAndBurnAddress);

    uriGenerator = uriGenerator || await CawNameURI.new();
    console.log("URI Generator addr", uriGenerator.address);

    cawNamesL2 = cawNamesL2 || await CawNameL2.new(l2Endpoint.address);
    await l1Endpoint.setDestLzEndpoint(cawNamesL2.address, l2Endpoint.address);

    cawNames = cawNames || await CawName.new(cawAddress, uriGenerator.address, buyAndBurnAddress, clientManager.address, l1Endpoint.address, l1);
    await cawNamesL2.setL1Peer(l1, cawNames.address, false);
    await l2Endpoint.setDestLzEndpoint(cawNames.address, l1Endpoint.address);
    await cawNames.setL2Peer(l2, cawNamesL2.address);

    await clientManager.createClient(accounts[0], 1,1,1,1);


    cawNamesL2Mainnet = cawNamesL2Mainnet || await CawNameL2.new(l1Endpoint.address);
    await cawNamesL2Mainnet.setL1Peer(l1, cawNames.address, true);
    await cawNames.setL2Peer(l1, cawNamesL2Mainnet.address);

    minter = minter || await CawNameMinter.new(cawAddress, cawNames.address);
    await cawNames.setMinter(minter.address);
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


    try {
      tx = await buyUsername(accounts[2], name);
    } catch(err) { error = err.message; }
    expect(error).to.include('has already been taken');
    error = null;
    console.log("SUCCESS 3")


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

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.cawActions)
			console.log('args', args);
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
    var result = await processActions([firstCaw], {
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
      var actions = decodeActions(args.cawActions)
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




    result = await processActions([{
      actionType: 'like',
      cawId: secondCawId,
      sender: accounts[2],
      receiverCawonce: 0,
      receiverId: 2,
      senderId: 1,
			amounts: [(10000000n * 10n**18n).toString()]
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
    result = await processActions([{
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

    // result = truffleAssert.eventEmitted(result.tx, 'ActionsProcessed');

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.cawInteractions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });

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
    result = await processActions([{
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

    var balance = BigInt(await cawNamesL2.cawBalanceOf(1));

    var cawonce1 = Number(await cawActions.nextCawonce(1));
		var withdrawAmount = balance*3n/10n;

    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(withdrawAmount).toString()],
      recipients: [1],
      sender: accounts[2],
      senderId: 1,
      cawonce: cawonce1,
    }]

    result = await processActions(actionsToProcess, { validator: accounts[1] });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.withdrawActions)
			console.log(actions);
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });
    var newBalance = BigInt(await cawNamesL2.cawBalanceOf(1));

    expect(newBalance/ 100n).to.equal((balance - withdrawAmount)/100n)


    var balanceWas = BigInt(await token.balanceOf(accounts[2]))
    var quote = await cawNames.withdrawQuote(defaultClientId, false);
    await cawNames.withdraw(defaultClientId, 1, 0, {
      value: quote?.nativeFee,
      from: accounts[2]
    });
    var newBalance = BigInt(await token.balanceOf(accounts[2]))

    expect(newBalance).to.equal(balanceWas + withdrawAmount)


    // Transfering the username will not propogate
    // to the L2 until an action is taken on L1
    // For example, a deposit on the L1.
    await cawNames.transferFrom(accounts[2], accounts[3], 1, {
      from: accounts[2],
    })


    var cawonce1 = Number(await cawActions.nextCawonce(1));
    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(balance*3n/10n).toString()],
      recipients: [1],
      sender: accounts[3],
      senderId: 1,
      cawonce: cawonce1,
    }]


    result = await processActions(actionsToProcess, { validator: accounts[1] });

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
      var actions = decodeActions(args.withdrawActions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });

    var balanceWas = BigInt(await token.balanceOf(accounts[3]))
    var quote = await cawNames.withdrawQuote(defaultClientId, false);
    await cawNames.withdraw(defaultClientId, 1, 0, {
      value: quote?.nativeFee,
      from: accounts[3]
    });
    var newBalance = BigInt(await token.balanceOf(accounts[3]))

    expect(newBalance).to.equal(balanceWas + (balance*3n/10n))


    // and this one should fail:
    var actionsToProcess = [{
      actionType: 'withdraw',
      amounts: [(balance*3n/10n).toString()],
      recipients: [1],
      sender: accounts[2],
      senderId: 1,
      cawonce: cawonce1,
    }]


    result = await processActions(actionsToProcess, { validator: accounts[1] });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'Cawonce already used';
    });





    await clientManager.createClient(accounts[0], 1,1,1,1);



    var unauthedCaw = {
      actionType: 'caw',
      text: "Send Caw to a new client beofre authing",
      sender: accounts[3],
      clientId: 2,
      senderId: 1,
    };
    var result = await processActions([unauthedCaw], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'User not authenticated';
    });

    var quote = await cawNames.authenticateQuote(2, 1, l2, false);
    await cawNames.authenticate(2, 1, l2, quote.lzTokenFee, {
      value: quote?.nativeFee,
      from: accounts[3]
    });
    var result = await processActions([unauthedCaw], {
      validator: accounts[2]
    });

    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
      var actions = decodeActions(args.cawActions)
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });



    // Another unauthed caw that becomes authed by depositing:
    await clientManager.createClient(accounts[0], 1,1,1,1);

    var unauthedCaw = {
      actionType: 'caw',
      text: "Send Caw to a new client before authing",
      sender: accounts[3],
      clientId: 3,
      senderId: 1,
    };
    var result = await processActions([unauthedCaw], {
      validator: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      console.log(args);
      return args.cawonce == result.signedActions[0].data.message.cawonce &&
				args.senderId == result.signedActions[0].data.message.senderId &&
        args.reason == 'User not authenticated';
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
			// console.log("Raw ACTION data: ", args.actions);
      var actions = decodeActions(args.cawActions);
      return actions[0].cawonce == result.signedActions[0].data.message.cawonce &&
				actions[0].senderId == result.signedActions[0].data.message.senderId;
    });




		var a = [];
		for (var i=0;i<256;i++)
			a.push({...unauthedCaw});
    var result = await processActions(a, {
      validator: accounts[2]
    });
    truffleAssert.eventEmitted(result.tx, 'ActionsProcessed', (args) => {
			console.log("Raw ACTION data: ", args.cawActions.length);
			// return true;
      return args.cawActions.length == 256;
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

    console.log("TOTAL GAS USED:", totalGas);

  });

});

