
// just run:
// .load ./scripts/l2_helpers.js
// r = await processActions([firstLike], {validator: accounts[0]})
//
// r.tx.receipt.logs[0].args
//



  l2 = 40245;
  l1 = 40161;
  defaultClientId = 1;

cawProfilesL2Address = '0x55C66CAbF9766AeFB3a770d9ea64E218dF195D9B';
cawActionsAddress = "0xf3FF3891332be3Cb0A28B94218b416454133b26f";

(async () => {
  cawProfiles = await CawProfileL2.at(cawProfilesL2Address);
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

const truffleAssert = require('truffle-assertions');

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
    { name: 'amounts', type: 'uint128[]' },
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
  console.log("SIgning:::", data);
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

 
async function safeProcessActions(actions, params) {
  console.log("---");
  console.log("SAFE PROCESS ACTIONS");
  var cawonces = {}

  global.signedActions = []
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
  // cawActions.processAction(1, data.message, sigData.v, sigData.r, sigData.s)


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

  t = await cawActions.safeProcessActions(params.validatorId || 1, transactionData, 0, txOptions);

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

  console.log("attempting to simulate ", transactionData.actions.length, "actions");

  // simulate process actions to check which actions will be successful:
  var result = await cawActions.safeProcessActions.call(
    params.validatorId || 1,
    transactionData,
    0, // modify as needed
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
    t = await cawActions.processActions(params.validatorId || 1, transactionData, 0, txOptions);
    console.log("Wait.. what happened")

    var fullTx = await web3.eth.getTransaction(t.tx);
    console.log("processed", signedActions.length, "actions. GAS units:", BigInt(t.receipt.gasUsed));
    // totalGas += BigInt(t.receipt.gasUsed);
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

  var domain = {
    chainId: 84532,
    name: 'CawNet',
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
  if (recoverAddr != user.toLowerCase())
    throw("signatures didn't work");

  return { r, s, v };
}

global.firstCaw = {
  actionType: 'caw',
  text: "another caw",
  sender: accounts[0],
  senderId: 1,
};
global.firstLike = {
  actionType: 'like',
  receiverCawonce: 1,
  sender: accounts[0],
  receiverId: 1,
  senderId: 1,
  amounts: [10]
};
