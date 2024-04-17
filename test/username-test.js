const IERC20 = artifacts.require("IERC20");
const CawNameURI = artifacts.require("CawNameURI");
const Usernames = artifacts.require("CawName");
const CawNameMinter = artifacts.require("CawNameMinter");
const CawActions = artifacts.require("CawActions");
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

var minter;
var swapper;
var usernames;
var cawActions;
var uriGenerator;
var token;

const dataTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  ActionData: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint64' },
    { name: 'receiverId', type: 'uint64' },
    { name: 'tipRecipients', type: 'uint64[]' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'tips', type: 'uint256[]' },
    { name: 'sender', type: 'address' },
    { name: 'cawId', type: 'bytes32' },
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

async function signData(user, data) {
  var privateKey = web3.eth.currentProvider.wallets[user.toLowerCase()].getPrivateKey()
  return signTypedData({
    data: data,
    privateKey: privateKey,
    version: SignTypedDataVersion.V4
  });
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

async function processActions(actions, params) {
  console.log("---");
  console.log("PROCESS ACTIONS");
  var signedActions = await Promise.all(actions.map(async function(params) {
    var data = await generateData(params.actionType, params);
    // console.log("Signing with data:", data);
    var sig = await signData(params.sender, data);
    var sigData = await verifyAndSplitSig(sig, params.sender, data);

    return {
      data: data,
      sigData: sigData,
    };
  }));

    console.log("Data", signedActions.map(function(action) {return action.data.message}))

  t = await cawActions.processActions(params.senderId || 1, {
    v: signedActions.map(function(action) {return action.sigData.v}),
    r: signedActions.map(function(action) {return action.sigData.r}),
    s: signedActions.map(function(action) {return action.sigData.s}),
    actions: signedActions.map(function(action) {return action.data.message}),
  }, {
    nonce: await web3.eth.getTransactionCount(params.sender),
    from: params.sender,
  });

  var fullTx = await web3.eth.getTransaction(t.tx);
  console.log("processed", signedActions.length, "actions. GAS units:", BigInt(t.receipt.gasUsed));

  return {
    tx: t,
    signedActions: signedActions
  };
}

async function generateData(type, params = {}) {
  var actionType = {
    caw: 0,
    like: 1,
    recaw: 2,
    follow: 3,
  }[type];

  var domain = {
    chainId: 31337,
    name: 'CawNet',
    verifyingContract: cawActions.address,
    version: '1'
  };

  return {
    primaryType: 'ActionData',
    message: {
      actionType: actionType,
      sender: params.sender,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      timestamp: params.timestamp || (Math.floor(new Date().getTime() / 1000)),
      cawId: params.cawId || "0x0000000000000000000000000000000000000000000000000000000000000000",
      text: params.text || "",
      tipRecipients: [],
      tips: [],
    },
    domain: domain,
    types: {
      EIP712Domain: dataTypes.EIP712Domain,
      ActionData: dataTypes.ActionData,
    },
  };
}

async function verifyAndSplitSig(sig, user, data) {
  console.log('SIG', sig)
  // console.log('hashed SIG', web3.utils.soliditySha3(sig))
  
  const signatureSans0x = sig.substring(2)
  const r = '0x' + signatureSans0x.substring(0,64);
  const s = '0x' + signatureSans0x.substring(64,128);
  const v = parseInt(signatureSans0x.substring(128,130), 16)
  // console.log('v: ', v)
  // console.log('r: ', r)
  // console.log('s: ', s)
  const recoverAddr = recoverTypedSignature({data: data, signature: sig, version: SignTypedDataVersion.V4 })
  console.log('recovered address', recoverAddr)
  console.log('account: ', user)
  expect(recoverAddr).to.equal(user.toLowerCase())

  return { r, s, v };
}

async function deposit(user, tokenId, amount) {
  console.log("DEPOSIT", tokenId, (BigInt(amount) * 10n**18n).toString());

  var balance = await token.balanceOf(user)
  await token.approve(usernames.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  t = await usernames.deposit(tokenId, (BigInt(amount) * 10n**18n).toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  return t;
}

async function buyUsername(user, name) {

  var balance = await token.balanceOf(user)
  await token.approve(minter.address, balance.toString(), {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  t = await minter.mint(name, {
    nonce: await web3.eth.getTransactionCount(user),
    from: user,
  });

  return t;
}

async function buyToken(user, eth) {
  console.log("TOKEN:", token.address, swapper.address);
  t = await swapper.getAmountsOut(
    '100000000000000000',[
    wethAddress,
    usdcAddress,
    token.address,
  ]);
  console.log("TTTTT", t.toString());

  t = await swapper.swapExactETHForTokens('0',[
    wethAddress,
    usdcAddress,
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
  balance = await usernames.cawBalanceOf(tokenId);
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
    uriGenerator = uriGenerator || await CawNameURI.deployed();
    console.log("URI Generator addr", uriGenerator.address);
    minter = minter || await CawNameMinter.deployed();
    usernames = usernames || await Usernames.deployed();
    cawActions = cawActions || await CawActions.deployed();
    token = token || await IERC20.at(cawAddress);
    swapper = await ISwapper.at('0x7a250d5630b4cf539739df2c5dacb4c659f2488d'); // uniswap
  });

  it("", async function() {
    await buyToken(accounts[2], 100);
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

    // console.log("generator addr", await usernames.uriGenerator());
    console.log("URI", await usernames.usernames(0));


    tx = await deposit(accounts[2], 1, 10000);
    tx = await deposit(accounts[2], 2, 40000);
    tx = await deposit(accounts[2], 3, 10000);
    console.log("Done deposit");

    await expectBalanceOf(1, {toEqual: 10000});
    await expectBalanceOf(2, {toEqual: 40000});
    await expectBalanceOf(3, {toEqual: 10000});

    var timestamp = (Math.floor(new Date().getTime() / 1000));
    var result = await processActions([{
      actionType: 'caw',
      message: "the first caw message ever sent",
      sender: accounts[2],
      senderId: 1,
      timestamp: timestamp,
    }], {
      sender: accounts[2]
    });
    var cawId = result.signedActions[0].sigData.r;
    console.log("FISRT CAW SENT!", cawId);

    truffleAssert.eventEmitted(result.tx, 'ActionProcessed', (args) => {
      return args.senderId == 1n &&
        args.actionId == result.signedActions[0].sigData.r;
    });

    var isVerfied = await cawActions.isVerified(1, cawId);
    expect(isVerfied.toString()).to.equal('true');


    var rewardMultiplier = await usernames.rewardMultiplier();
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


    var result = await processActions([{
      actionType: 'caw',
      message: "the first caw message ever sent",
      timestamp: timestamp,
      sender: accounts[2],
      senderId: 1,
    }], {
      sender: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.senderId == 1n &&
        args.actionId == result.signedActions[0].sigData.r &&
        args.reason == 'this action has already been processed';
    });


    result = await processActions([{
      actionType: 'caw',
      message: "the second caw message ever sent",
      sender: accounts[2],
      senderId: 2,
    }], {
      sender: accounts[2]
    });

    truffleAssert.eventEmitted(result.tx, 'ActionProcessed', (args) => {
      return args.senderId == 2n &&
        args.actionId == result.signedActions[0].sigData.r;
    });

    var secondCawId = result.signedActions[0].sigData.r;

    rewardMultiplier = await usernames.rewardMultiplier();
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

    timestamp = Math.floor(new Date().getTime() / 1000);
    await processActions([{
      timestamp: timestamp,
      actionType: 'like',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 3,
    }], {
      sender: accounts[2]
    });

    var likes = await cawActions.likes(2, secondCawId);
    await expect(likes.toString()).to.equal('1');

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
      timestamp: timestamp,
      actionType: 'like',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 3,
    }], {
      sender: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.senderId == 3n &&
        args.actionId == result.signedActions[0].sigData.r &&
        args.reason == 'this action has already been processed';
    });


    timestamp = Math.floor(new Date().getTime() / 1000);
    await processActions([{
      timestamp: timestamp,
      actionType: 'follow',
      sender: accounts[2],
      receiverId: 1,
      senderId: 2,
    }], {
      sender: accounts[2]
    });

    var followCount = await cawActions.followerCount(1);
    await expect(followCount.toString()).to.equal('1');

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
      timestamp: timestamp,
      actionType: 'follow',
      sender: accounts[2],
      receiverId: 1,
      senderId: 2,
    }], {
      sender: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.senderId == 2n &&
        args.actionId == result.signedActions[0].sigData.r &&
        args.reason == 'this action has already been processed';
    });



    timestamp = Math.floor(new Date().getTime() / 1000);
    await processActions([{
      timestamp: timestamp,
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 1,
    }], {
      sender: accounts[2]
    });

    // var recawCount = await usernames.recawCount(1);
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

    result = await processActions([{
      timestamp: timestamp,
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 1,
    }], {
      sender: accounts[2]
    });

    console.log("Expect fail:")
    truffleAssert.eventEmitted(result.tx, 'ActionRejected', (args) => {
      return args.senderId == 1n &&
        args.actionId == result.signedActions[0].sigData.r &&
        args.reason == 'this action has already been processed';
    });


    tx = await deposit(accounts[2], 2, 2000000);

    var actionsToProcess = [{
      actionType: 'recaw',
      cawId: secondCawId,
      sender: accounts[2],
      receiverId: 2,
      senderId: 3,
    }, {
      actionType: 'like',
      sender: accounts[2],
      senderId: 1,
      cawId: secondCawId,
    }]

    for(var i = 0; i < 32; i++)
      actionsToProcess.push({
        actionType: 'caw',
        sender: accounts[2],
        senderId: 2,
        text: "This is a caw processed in a list of processed actions. " + i,
      });

    await processActions(actionsToProcess, { sender: accounts[1] });

    console.log("checking tokens");
    var tokens = await usernames.tokens(accounts[2]);
    console.log("TOKENS:", tokens);


  });

});
