
// just run:
// .load ./scripts/l2_helpers.js
// r = await processActions([firstCaw], {validator: accounts[0]})
//
// r.tx.receipt.logs[0].args
//



  l2 = 40245;
  l1 = 40161;
  defaultClientId = 1;

cawNamesL2Address = '0x07E59E70A03cEB68f2d73CCFF479b6CEabBa165c';
cawActionsAddress = "0xBab5E0ca318E713FB32675E6eE5e5eF6b3c877FF";

(async () => {
  cawNames = await CawNameL2.at(cawNamesL2Address);
  cawActions = await CawActions.at(cawActionsAddress);
})();

let {signTypedMessage} = require('@truffle/hdwallet-provider');
let { BN, expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
let {
  encrypt,
  recoverPersonalSignature,
  recoverTypedSignature,
  TypedMessage,
  MessageTypes,
  SignTypedDataVersion,
  signTypedData,
} = require('@metamask/eth-sig-util');


let dataTypes = {
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
    { name: 'recipients', type: 'uint64[]' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'amounts', type: 'uint256[]' },
    { name: 'sender', type: 'address' },
    { name: 'cawId', type: 'bytes32' },
    { name: 'text', type: 'string' },
  ],
};

async function signData(user, data) {
  var privateKey = web3.eth.currentProvider.wallets[user.toLowerCase()].getPrivateKey()
  return signTypedData({
    data: data,
    privateKey: privateKey,
    version: SignTypedDataVersion.V4
  });
}

async function processActions(actions, params) {
  console.log("---");
  console.log("PROCESS ACTIONS");
  global.signedActions = await Promise.all(actions.map(async function(action) {
    var data = await generateData(action.actionType, action);
    var sig = await signData(action.sender, data);
    var sigData = await verifyAndSplitSig(sig, action.sender, data);

    return {
      data: data,
      sigData: sigData,
    };
  }));

    console.log("Data", signedActions.map(function(action) {return action.data.message}))
    console.log("SENDER ID:", params.validatorId || 1);


  var withdraws = actions.filter(function(action) {return action.actionType == 'withdraw'});
  var quote;
  if (withdraws.length > 0) {
    var tokenIds = withdraws.map(function(action){return action.senderId});
    var amounts = withdraws.map(function(action){return action.amounts[0]});
    quote = await cawActions.withdrawQuote(tokenIds, amounts, false);
    console.log('withdraw quote returned:', quote);
  }

  console.log('Will process with quote:', quote?.nativeFee);
  t = await cawActions.processActions(params.validatorId || 1, {
    v: signedActions.map(function(action) {return action.sigData.v}),
    r: signedActions.map(function(action) {return action.sigData.r}),
    s: signedActions.map(function(action) {return action.sigData.s}),
    actions: signedActions.map(function(action) {return action.data.message}),
  }, 0, {
    nonce: await web3.eth.getTransactionCount(params.validator),
    from: params.validator,
    value: quote?.nativeFee || '0',
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
    unlike: 2,
    recaw: 3,
    follow: 4,
    unfollow: 5,
    withdraw: 6,
  }[type];

  var domain = {
    chainId: 84532,
    name: 'CawNet',
    verifyingContract: cawActions.address,
    version: '1'
  };

  var cawonce = params.cawonce;
  if (cawonce == undefined) 
    cawonce = Number(await cawActions.cawonce(params.senderId));

  return {
    primaryType: 'ActionData',
    message: {
      actionType: actionType,
      sender: params.sender,
      senderId: params.senderId,
      receiverId: params.receiverId || 0,
      timestamp: params.timestamp || BigInt(new Date().getTime())/1000n,
      cawId: params.cawId || "0x0000000000000000000000000000000000000000000000000000000000000000",
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
  console.log("RECOVERD CORRECTLY?", recoverAddr == user.toLowerCase());

  return { r, s, v };
}

timestamp = Number(BigInt(new Date().getTime())/1000n)
global.firstCaw = {
  actionType: 'caw',
  text: "the first caw message ever sent",
  sender: accounts[0],
  timestamp: timestamp,
  senderId: 1,
};
