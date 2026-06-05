//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawActions
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawActionsAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_cawProfiles', internalType: 'address', type: 'address' },
      { name: '_zkVerifier', internalType: 'address', type: 'address' },
      { name: '_zkProgramVKey', internalType: 'bytes32', type: 'bytes32' },
      { name: '_erc1271Sibling', internalType: 'address', type: 'address' },
      { name: '_capOracle', internalType: 'address', type: 'address' },
      { name: '_bootstrapRatio', internalType: 'uint192', type: 'uint192' },
      { name: '_bootstrapExpiry', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'capOracle',
    outputs: [
      { name: '', internalType: 'contract ICawCapOracle', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'capState',
    outputs: [
      { name: 'lastUpdatedAt', internalType: 'uint64', type: 'uint64' },
      { name: 'ratio', internalType: 'uint192', type: 'uint192' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'capStateRatio',
    outputs: [{ name: '', internalType: 'uint192', type: 'uint192' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [
      { name: '', internalType: 'contract CawProfileLedger', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'currentCawonceMap',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'eip712DomainHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'erc1271Sibling',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'externalSelf',
    outputs: [
      { name: '', internalType: 'contract CawActions', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'generateDomainHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'senderId', internalType: 'uint32', type: 'uint32' },
      { name: 'cawonce', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'isCawonceUsed',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'networkActionCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'networkCurrentHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'networkHashAtCheckpoint',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'senderId', internalType: 'uint32', type: 'uint32' }],
    name: 'nextCawonce',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      {
        name: 'action',
        internalType: 'struct CawActions.ActionData',
        type: 'tuple',
        components: [
          {
            name: 'actionType',
            internalType: 'enum CawActions.ActionType',
            type: 'uint8',
          },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'networkId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'bytes', type: 'bytes' },
        ],
      },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
      { name: 'packedSlice', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'processActionSingle',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      { name: 'packedActions', internalType: 'bytes', type: 'bytes' },
      { name: 'sigs', internalType: 'bytes', type: 'bytes' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      {
        name: 'withdrawLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
    ],
    name: 'processActions',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      { name: 'packedActions', internalType: 'bytes', type: 'bytes' },
      { name: 'packedSigs', internalType: 'bytes', type: 'bytes' },
      { name: 'signers', internalType: 'bytes', type: 'bytes' },
      { name: 'proof', internalType: 'bytes', type: 'bytes' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      {
        name: 'withdrawLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
    ],
    name: 'processActionsWithZkSigs',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      { name: 'groupBytes', internalType: 'bytes', type: 'bytes' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
      { name: 'groupSize', internalType: 'uint16', type: 'uint16' },
      { name: 'preVerifiedSigner', internalType: 'address', type: 'address' },
    ],
    name: 'processGroupSingle',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      { name: 'packedActions', internalType: 'bytes', type: 'bytes' },
      { name: 'sigs', internalType: 'bytes', type: 'bytes' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      {
        name: 'withdrawLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
    ],
    name: 'safeProcessActions',
    outputs: [
      { name: 'successCount', internalType: 'uint256', type: 'uint256' },
      { name: 'rejections', internalType: 'bytes[]', type: 'bytes[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'sessionSpent',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'newRatio', internalType: 'uint192', type: 'uint192' }],
    name: 'setCapRatio',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newRatio', internalType: 'uint192', type: 'uint192' }],
    name: 'setTipRatio',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'tipState',
    outputs: [
      { name: 'lastUpdatedAt', internalType: 'uint64', type: 'uint64' },
      { name: 'ratio', internalType: 'uint192', type: 'uint192' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'usedCawonce',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'withdrawQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'zkProgramVKey',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'zkVerifier',
    outputs: [
      { name: '', internalType: 'contract ISP1Verifier', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'senderId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'cawonce',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      { name: 'reason', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'ActionRejected',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'validatorId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'actionCount',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'batchHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'ActionsProcessed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'validatorId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'actionCount',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'actionsExecutedBitmap',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'batchHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'ActionsProcessedZk',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'ratio',
        internalType: 'uint192',
        type: 'uint192',
        indexed: false,
      },
      {
        name: 'timestamp',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'CapRatioUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'ratio',
        internalType: 'uint192',
        type: 'uint192',
        indexed: false,
      },
      {
        name: 'timestamp',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'TipRatioUpdated',
  },
  { type: 'error', inputs: [], name: 'BadSigGroupCount' },
  { type: 'error', inputs: [], name: 'BatchSigInvalid' },
  { type: 'error', inputs: [], name: 'CawonceUsed' },
  { type: 'error', inputs: [], name: 'EmptyGroup' },
  { type: 'error', inputs: [], name: 'GroupOverflows' },
  { type: 'error', inputs: [], name: 'InvalidActionType' },
  { type: 'error', inputs: [], name: 'InvalidSig' },
  { type: 'error', inputs: [], name: 'InvalidValidator' },
  { type: 'error', inputs: [], name: 'MixedNetworks' },
  { type: 'error', inputs: [], name: 'MixedSenders' },
  { type: 'error', inputs: [], name: 'NoActions' },
  { type: 'error', inputs: [], name: 'NoWithdrawFee' },
  { type: 'error', inputs: [], name: 'NonContiguousCawonces' },
  { type: 'error', inputs: [], name: 'NotCapOracle' },
  { type: 'error', inputs: [], name: 'NotSibling' },
  { type: 'error', inputs: [], name: 'OnlySelf' },
  { type: 'error', inputs: [], name: 'OutOfScope' },
  { type: 'error', inputs: [], name: 'SelfFollow' },
  { type: 'error', inputs: [], name: 'SessionExpired' },
  { type: 'error', inputs: [], name: 'SessionLimitExceeded' },
  { type: 'error', inputs: [], name: 'SignerMismatch' },
  { type: 'error', inputs: [], name: 'SigsIncomplete' },
  { type: 'error', inputs: [], name: 'TextTooLong' },
  { type: 'error', inputs: [], name: 'TooManyActions' },
  { type: 'error', inputs: [], name: 'TooManyRecipients' },
  { type: 'error', inputs: [], name: 'TrailingBytes' },
  { type: 'error', inputs: [], name: 'UnknownOwner' },
  { type: 'error', inputs: [], name: 'UserNotAuth' },
  { type: 'error', inputs: [], name: 'WithdrawZeroAmount' },
  { type: 'error', inputs: [], name: 'WrongProfileForSession' },
  { type: 'error', inputs: [], name: 'ZkNotConfigured' },
  { type: 'error', inputs: [], name: 'ZkSignersMismatch' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawActionsArchive
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawActionsArchiveAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: '_pathwayExpander', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [],
    name: 'CHALLENGE_PERIOD',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'CHECKPOINT_INTERVAL',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'CLAIM_COOLDOWN',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_CHECKPOINTS_PER_SUBMISSION',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_PENDING_PER_VALIDATOR',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MIN_STAKE',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'payload', internalType: 'bytes', type: 'bytes' }],
    name: '_processChallenge',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
    ],
    name: 'allowInitializePath',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'challengeDelivered',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'challengeHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'checkpointClaimReopensAt',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'checkpointClaimed',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'endpoint',
    outputs: [
      {
        name: '',
        internalType: 'contract ILayerZeroEndpointV2',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'finalizeSubmission',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'getSubmission',
    outputs: [
      { name: 'submitter', internalType: 'address', type: 'address' },
      { name: 'merkleRoot', internalType: 'bytes32', type: 'bytes32' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'startCheckpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'endCheckpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'finalizedAt', internalType: 'uint256', type: 'uint256' },
      {
        name: 'status',
        internalType: 'enum CawActionsArchive.Status',
        type: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'validator', internalType: 'address', type: 'address' }],
    name: 'getValidatorSubmissionCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'isComposeMsgSender',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'start', internalType: 'uint256', type: 'uint256' },
      { name: 'end', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'isRangeAvailable',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_executor', internalType: 'address', type: 'address' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzReceive',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: 'nonce', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextSubmissionId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'pendingCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'claimedHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'merkleProof', internalType: 'bytes32[]', type: 'bytes32[]' },
    ],
    name: 'resolveChallenge',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_delegate', internalType: 'address', type: 'address' }],
    name: 'setDelegate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_peer', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'setPeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'packedActions', internalType: 'bytes', type: 'bytes' },
      { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 'entryHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'slashIncoherentRoot',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'stakes',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'submissions',
    outputs: [
      { name: 'submitter', internalType: 'address', type: 'address' },
      { name: 'merkleRoot', internalType: 'bytes32', type: 'bytes32' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'startCheckpointId', internalType: 'uint64', type: 'uint64' },
      { name: 'endCheckpointId', internalType: 'uint64', type: 'uint64' },
      { name: 'finalizedAt', internalType: 'uint64', type: 'uint64' },
      {
        name: 'status',
        internalType: 'enum CawActionsArchive.Status',
        type: 'uint8',
      },
      { name: 'dataCommitment', internalType: 'bytes32', type: 'bytes32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'startCheckpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'endCheckpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'packedActions', internalType: 'bytes', type: 'bytes' },
      { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 'merkleRoot', internalType: 'bytes32', type: 'bytes32' },
      { name: 'entryHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'submitReplication',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'validatorSubmissions',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'amount', internalType: 'uint256', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'actionCount',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'packedHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'rHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'entryHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'ActionsArchived',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'payload', internalType: 'bytes', type: 'bytes', indexed: false },
      { name: 'reason', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'ChallengeDeliveryFailed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'checkpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'correctHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'ChallengeHashDelivered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'validator',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'totalStake',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Deposited',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'peer',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PeerSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'submitter',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'startCheckpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'endCheckpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'merkleRoot',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'SubmissionCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'SubmissionFinalized',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'validator',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'challenger',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'checkpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'reward',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ValidatorSlashed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'validator',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'remaining',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Withdrawn',
  },
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  { type: 'error', inputs: [], name: 'LzTokenUnavailable' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
  },
  {
    type: 'error',
    inputs: [{ name: 'msgValue', internalType: 'uint256', type: 'uint256' }],
    name: 'NotEnoughNative',
  },
  {
    type: 'error',
    inputs: [{ name: 'addr', internalType: 'address', type: 'address' }],
    name: 'OnlyEndpoint',
  },
  {
    type: 'error',
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'OnlyPeer',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawChallengeRelay
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawChallengeRelayAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: '_cawActions', internalType: 'address', type: 'address' },
      { name: '_pathwayExpander', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'CHALLENGE_GAS_BASE',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'CHALLENGE_GAS_PER_CP',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
    ],
    name: 'allowInitializePath',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawActions',
    outputs: [
      {
        name: '',
        internalType: 'contract ICawActionsCheckpoints',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'endpoint',
    outputs: [
      {
        name: '',
        internalType: 'contract ILayerZeroEndpointV2',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'isComposeMsgSender',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_executor', internalType: 'address', type: 'address' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzReceive',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: 'nonce', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'quoteChallenge',
    outputs: [
      {
        name: '',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointIds', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'quoteChallengeBatch',
    outputs: [
      {
        name: '',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'relayChallenge',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'submissionId', internalType: 'uint256', type: 'uint256' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointIds', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    name: 'relayChallengeBatch',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_delegate', internalType: 'address', type: 'address' }],
    name: 'setDelegate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_peer', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'setPeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'checkpointIds',
        internalType: 'uint256[]',
        type: 'uint256[]',
        indexed: false,
      },
      {
        name: 'destEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
    ],
    name: 'ChallengeBatchRelayed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'submissionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'checkpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'destEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'correctHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'ChallengeRelayed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'peer',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PeerSet',
  },
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'optionType', internalType: 'uint16', type: 'uint16' }],
    name: 'InvalidOptionType',
  },
  { type: 'error', inputs: [], name: 'LzTokenUnavailable' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
  },
  {
    type: 'error',
    inputs: [{ name: 'msgValue', internalType: 'uint256', type: 'uint256' }],
    name: 'NotEnoughNative',
  },
  {
    type: 'error',
    inputs: [{ name: 'addr', internalType: 'address', type: 'address' }],
    name: 'OnlyEndpoint',
  },
  {
    type: 'error',
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'OnlyPeer',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawNetworkManager
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNetworkManagerAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_buyAndBurn', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_GAS_OVERRIDE',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MAX_TIP_TARGET_WEI',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'instanceId', internalType: 'uint32', type: 'uint32' }],
    name: 'activateInstance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'buyAndBurnAddress',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
    ],
    name: 'changeOwner',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'feeAddress', internalType: 'address', type: 'address' },
      { name: 'storageChainEid', internalType: 'uint32', type: 'uint32' },
      { name: 'withdrawFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'authFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'tipCeilingWei', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'createNetwork',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'instanceId', internalType: 'uint32', type: 'uint32' }],
    name: 'deactivateInstance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
    ],
    name: 'gasOverride',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getAuthFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getAuthFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getAuthFeeCeiling',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getDepositFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getDepositFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getDepositFeeCeiling',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getMintFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getMintFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getMintFeeCeiling',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getNetwork',
    outputs: [
      {
        name: '',
        internalType: 'struct CawNetwork',
        type: 'tuple',
        components: [
          { name: 'id', internalType: 'uint32', type: 'uint32' },
          { name: 'storageChainEid', internalType: 'uint32', type: 'uint32' },
          { name: 'name', internalType: 'string', type: 'string' },
          { name: 'feeAddress', internalType: 'address', type: 'address' },
          { name: 'ownerAddress', internalType: 'address', type: 'address' },
          { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
          { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
          { name: 'authFee', internalType: 'uint256', type: 'uint256' },
          { name: 'creationBlock', internalType: 'uint256', type: 'uint256' },
          {
            name: 'withdrawFeeCeiling',
            internalType: 'uint256',
            type: 'uint256',
          },
          {
            name: 'depositFeeCeiling',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'authFeeCeiling', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFeeCeiling', internalType: 'uint256', type: 'uint256' },
          { name: 'tipTargetWei', internalType: 'uint256', type: 'uint256' },
          { name: 'tipCeilingWei', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getNetworkOwner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getStorageChainEid',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getTipCeilingWei',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getTipTargetWei',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getWithdrawFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'getWithdrawFeeCeiling',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'instanceActive',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'instanceOwner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'lockNetworkFees',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'lockNetworkOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newCeiling', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'lowerAuthFeeCeiling',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newCeiling', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'lowerDepositFeeCeiling',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newCeiling', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'lowerMintFeeCeiling',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newCeiling', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'lowerTipCeiling',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'newCeiling', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'lowerWithdrawFeeCeiling',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'networkFeesLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bytes4', type: 'bytes4' },
    ],
    name: 'networkGasOverride',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'networkOwnershipLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'networks',
    outputs: [
      { name: 'id', internalType: 'uint32', type: 'uint32' },
      { name: 'storageChainEid', internalType: 'uint32', type: 'uint32' },
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'feeAddress', internalType: 'address', type: 'address' },
      { name: 'ownerAddress', internalType: 'address', type: 'address' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
      { name: 'authFee', internalType: 'uint256', type: 'uint256' },
      { name: 'creationBlock', internalType: 'uint256', type: 'uint256' },
      { name: 'withdrawFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'authFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFeeCeiling', internalType: 'uint256', type: 'uint256' },
      { name: 'tipTargetWei', internalType: 'uint256', type: 'uint256' },
      { name: 'tipCeilingWei', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextInstanceId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextNetworkId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'apiUrl', internalType: 'string', type: 'string' },
      { name: 'validatorAddress', internalType: 'address', type: 'address' },
    ],
    name: 'registerInstance',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setAuthFee',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_cawProfile', internalType: 'address', type: 'address' }],
    name: 'setCawProfile',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDepositFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'feeAddress', internalType: 'address', type: 'address' },
    ],
    name: 'setFeeAddress',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
      { name: 'authFee', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setFees',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
      { name: 'newAmount', internalType: 'uint128', type: 'uint128' },
    ],
    name: 'setGasOverride',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setMintFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setTipTarget',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setWithdrawFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'instanceId', internalType: 'uint32', type: 'uint32' },
      { name: 'apiUrl', internalType: 'string', type: 'string' },
      { name: 'validatorAddress', internalType: 'address', type: 'address' },
    ],
    name: 'updateInstance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'oldCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'newCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'AuthFeeCeilingLowered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'cawProfile',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'CawProfileSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'oldCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'newCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'DepositFeeCeilingLowered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'instanceId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'InstanceActivated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'instanceId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'InstanceDeactivated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'instanceId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'apiUrl',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
      {
        name: 'validatorAddress',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'InstanceRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'instanceId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'apiUrl',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
      {
        name: 'validatorAddress',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'InstanceUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'oldCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'newCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MintFeeCeilingLowered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'network',
        internalType: 'struct CawNetwork',
        type: 'tuple',
        components: [
          { name: 'id', internalType: 'uint32', type: 'uint32' },
          { name: 'storageChainEid', internalType: 'uint32', type: 'uint32' },
          { name: 'name', internalType: 'string', type: 'string' },
          { name: 'feeAddress', internalType: 'address', type: 'address' },
          { name: 'ownerAddress', internalType: 'address', type: 'address' },
          { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
          { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
          { name: 'authFee', internalType: 'uint256', type: 'uint256' },
          { name: 'creationBlock', internalType: 'uint256', type: 'uint256' },
          {
            name: 'withdrawFeeCeiling',
            internalType: 'uint256',
            type: 'uint256',
          },
          {
            name: 'depositFeeCeiling',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'authFeeCeiling', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFeeCeiling', internalType: 'uint256', type: 'uint256' },
          { name: 'tipTargetWei', internalType: 'uint256', type: 'uint256' },
          { name: 'tipCeilingWei', internalType: 'uint256', type: 'uint256' },
        ],
        indexed: false,
      },
    ],
    name: 'NetworkCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'feeType',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
      {
        name: 'newFee',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'NetworkFeeUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'NetworkFeesLocked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'selector',
        internalType: 'bytes4',
        type: 'bytes4',
        indexed: true,
      },
      {
        name: 'newAmount',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
    ],
    name: 'NetworkGasOverrideSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'NetworkOwnershipLocked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'oldCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'newCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'TipCeilingLowered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'networkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'oldCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'newCeiling',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'WithdrawFeeCeilingLowered',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfile
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_caw', internalType: 'address', type: 'address' },
      { name: '_gui', internalType: 'address', type: 'address' },
      { name: '_buyAndBurn', internalType: 'address', type: 'address' },
      { name: '_networkManager', internalType: 'address', type: 'address' },
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: 'mainnetEid', internalType: 'uint32', type: 'uint32' },
      { name: '_priceReader', internalType: 'address', type: 'address' },
      { name: '_cawProfileLedger', internalType: 'address', type: 'address' },
      { name: '_pathwayExpander', internalType: 'address', type: 'address' },
      { name: '_minter', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'fallback', stateMutability: 'payable' },
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [],
    name: 'CAW',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'accruedFees',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
    ],
    name: 'allowInitializePath',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'authenticate',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'authenticateForMinter',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'authenticated',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'broadcastAllowFreeAuth',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'broadcastTipTarget',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'buyAndBurn',
    outputs: [
      { name: '', internalType: 'contract CawBuyAndBurn', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfileLedger',
    outputs: [
      { name: '', internalType: 'contract CawProfileLedger', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'depositFor',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'endpoint',
    outputs: [
      {
        name: '',
        internalType: 'contract ILayerZeroEndpointV2',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'getApproved',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'operator', internalType: 'address', type: 'address' },
    ],
    name: 'isApprovedForAll',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'isComposeMsgSender',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'lockedWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
      { name: 'n', internalType: 'uint256', type: 'uint256' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: '_payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'lzQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_executor', internalType: 'address', type: 'address' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzReceive',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'mainnetLzId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'newId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'newId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'sessionExtra', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'mintAndAuth',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'newId', internalType: 'uint32', type: 'uint32' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'sessionExtra', internalType: 'bytes', type: 'bytes' },
      { name: 'sponsorTokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'repayAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDeposit',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'minter',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'networkManager',
    outputs: [
      { name: '', internalType: 'contract CawNetworkManager', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: 'nonce', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'pendingTransferUpdates',
    outputs: [
      { name: '', internalType: 'uint32[]', type: 'uint32[]' },
      { name: '', internalType: 'address[]', type: 'address[]' },
      { name: '', internalType: 'uint64[]', type: 'uint64[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'pendingTransfers',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'priceReader',
    outputs: [
      { name: '', internalType: 'contract CawL1PriceReader', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardMultiplier',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'safeTransferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'safeTransferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'operator', internalType: 'address', type: 'address' },
      { name: 'approved', internalType: 'bool', type: 'bool' },
    ],
    name: 'setApprovalForAll',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_delegate', internalType: 'address', type: 'address' }],
    name: 'setDelegate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'refundTo', internalType: 'address payable', type: 'address' },
    ],
    name: 'setLzRefundTo',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_peer', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'setPeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    name: 'setWithdrawable',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'interfaceId', internalType: 'bytes4', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'syncTransfer',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'index', internalType: 'uint256', type: 'uint256' }],
    name: 'tokenByIndex',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'index', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalCaw',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferAndSync',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'uriGenerator',
    outputs: [
      { name: '', internalType: 'contract CawProfileURI', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'usernames',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'withdrawFeeLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'minCawOut', internalType: 'uint256', type: 'uint256' }],
    name: 'withdrawFees',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'minCawOut', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdrawFeesFor',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdrawTo',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'withdrawable',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'approved',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'operator',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      { name: 'approved', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'ApprovalForAll',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'cawNetworkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'lzDestId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'depositor',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'Deposited',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'recipient',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'FeesAccrued',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'recipient',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'FeesWithdrawn',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'peer',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PeerSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'tokenId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'Transfer',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
    ],
    name: 'TransferPendingSync',
  },
  { type: 'error', inputs: [], name: 'DelegateFailed' },
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'optionType', internalType: 'uint16', type: 'uint16' }],
    name: 'InvalidOptionType',
  },
  { type: 'error', inputs: [], name: 'LzTokenUnavailable' },
  { type: 'error', inputs: [], name: 'NoFees' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
  },
  { type: 'error', inputs: [], name: 'NoPending' },
  { type: 'error', inputs: [], name: 'NotApproved' },
  {
    type: 'error',
    inputs: [{ name: 'msgValue', internalType: 'uint256', type: 'uint256' }],
    name: 'NotEnoughNative',
  },
  { type: 'error', inputs: [], name: 'NotL2Mirror' },
  { type: 'error', inputs: [], name: 'NotMinter' },
  { type: 'error', inputs: [], name: 'NotNetOwner' },
  { type: 'error', inputs: [], name: 'NotOwner' },
  { type: 'error', inputs: [], name: 'NothingToWithdraw' },
  {
    type: 'error',
    inputs: [{ name: 'addr', internalType: 'address', type: 'address' }],
    name: 'OnlyEndpoint',
  },
  {
    type: 'error',
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'OnlyPeer',
  },
  { type: 'error', inputs: [], name: 'RefundFailed' },
  { type: 'error', inputs: [], name: 'RepayCrossChainUnsupported' },
  { type: 'error', inputs: [], name: 'TooManyChains' },
  { type: 'error', inputs: [], name: 'Unauthorized' },
  { type: 'error', inputs: [], name: 'ZeroAddr' },
  { type: 'error', inputs: [], name: 'ZeroDeposit' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileLedger
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileLedgerAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_endpointId', internalType: 'uint32', type: 'uint32' },
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: '_capOracle', internalType: 'address', type: 'address' },
      { name: '_cawProfile', internalType: 'address', type: 'address' },
      { name: '_cawActions', internalType: 'address', type: 'address' },
      { name: '_erc1271Sibling', internalType: 'address', type: 'address' },
      { name: '_bypassLZ', internalType: 'bool', type: 'bool' },
      { name: '_pathwayExpander', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'addToBalance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'addTokensToBalance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'allowFreeAuth',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
    ],
    name: 'allowInitializePath',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'auth',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'authenticated',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'bypassLZ',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'capOracle',
    outputs: [
      { name: '', internalType: 'contract ICawCapOracle', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawActions',
    outputs: [
      { name: '', internalType: 'contract ICawActions', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint32', type: 'uint32' }],
    name: 'cawBalanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'cawOwnership',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [
      { name: '', internalType: 'contract CawProfile', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'eip712DomainHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'endpoint',
    outputs: [
      {
        name: '',
        internalType: 'contract ILayerZeroEndpointV2',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'erc1271Sibling',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint32', type: 'uint32' }],
    name: 'forgiveSponsorRepay',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' }],
    name: 'getTokens',
    outputs: [
      {
        name: '',
        internalType: 'struct CawProfileLedger.Token[]',
        type: 'tuple[]',
        components: [
          { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
          { name: 'balance', internalType: 'uint256', type: 'uint256' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'cawBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'nextCawonce', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'isComposeMsgSender',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'lastOwnerUpdateBlock',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'layer1EndpointId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'owners', internalType: 'address[]', type: 'address[]' },
      { name: 'stamps', internalType: 'uint64[]', type: 'uint64[]' },
    ],
    name: 'lzDepositMintSession',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_executor', internalType: 'address', type: 'address' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzReceive',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'stamp', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'stamp', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'mintAndAuth',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'networkId', internalType: 'uint32', type: 'uint32' }],
    name: 'networkTipTargetWei',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: 'nonce', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'ownerSessionEpoch',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'precision',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'signer', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'scopeBitmap', internalType: 'uint8', type: 'uint8' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
      { name: 'nonce', internalType: 'uint256', type: 'uint256' },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'registerSession',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'registerSessionFromActions',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'registerSessionFromL1',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'signer', internalType: 'address', type: 'address' },
      { name: 'message', internalType: 'bytes', type: 'bytes' },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'registerSessionPersonal',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'sponsorTokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'repayAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'registerSponsorRepayFromL1',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'profileId', internalType: 'uint32', type: 'uint32' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'scopeBitmap', internalType: 'uint8', type: 'uint8' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
      { name: 'nonce', internalType: 'uint256', type: 'uint256' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'registerTokenScopedSession',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'repaySponsorTokenId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'sessionKey', internalType: 'address', type: 'address' }],
    name: 'revokeSession',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'revokeSessionBySig',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
    ],
    name: 'revokeSessionFromActions',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'rewardMultiplier',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'sessionNonce',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    name: 'sessions',
    outputs: [
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'scopeBitmap', internalType: 'uint8', type: 'uint8' },
      { name: 'epoch', internalType: 'uint32', type: 'uint32' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
      { name: 'profileId', internalType: 'uint32', type: 'uint32' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'allow', internalType: 'bool', type: 'bool' },
      { name: 'seq', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'setAllowFreeAuth',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_delegate', internalType: 'address', type: 'address' }],
    name: 'setDelegate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'targetWei', internalType: 'uint256', type: 'uint256' },
      { name: 'seq', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'setNetworkTipTarget',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
      { name: 'stamp', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'setOwnerOf',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_peer', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'setPeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setWithdrawable',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'setWithdrawableSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amountToSpend', internalType: 'uint256', type: 'uint256' },
      { name: 'amountToDistribute', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'spendAndDistribute',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amountToSpend', internalType: 'uint256', type: 'uint256' },
      { name: 'amountToDistribute', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'spendAndDistributeTokens',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amountToSpend', internalType: 'uint256', type: 'uint256' },
      { name: 'amountToDistribute', internalType: 'uint256', type: 'uint256' },
      { name: 'recipientId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipientAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'spendDistributeAndAddTokensToBalance',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'sponsorRepay',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'sponsorSweepPreview',
    outputs: [{ name: 'swept', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'sweepSponsorRepay',
    outputs: [{ name: 'swept', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'tokenSessionNonce',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalCaw',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'owners', internalType: 'address[]', type: 'address[]' },
      { name: 'stamps', internalType: 'uint64[]', type: 'uint64[]' },
    ],
    name: 'updateOwners',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'usernames',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
    ],
    name: 'validSession',
    outputs: [
      {
        name: 's',
        internalType: 'struct CawProfileLedger.StoredSession',
        type: 'tuple',
        components: [
          { name: 'expiry', internalType: 'uint64', type: 'uint64' },
          { name: 'scopeBitmap', internalType: 'uint8', type: 'uint8' },
          { name: 'epoch', internalType: 'uint32', type: 'uint32' },
          { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
          { name: 'profileId', internalType: 'uint32', type: 'uint32' },
          { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'withdrawQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdrawTokens',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'cawNetworkId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
    ],
    name: 'Authenticated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'OwnerSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'previousOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'newOwner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'OwnershipTransferred',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'peer',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PeerSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'sessionKey',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'expiry',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
      {
        name: 'scopeBitmap',
        internalType: 'uint8',
        type: 'uint8',
        indexed: false,
      },
      {
        name: 'spendLimit',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'perActionTipRate',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'SessionCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'sessionKey',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'SessionRevoked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'sponsorTokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
    ],
    name: 'SponsorRepayForgiven',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'sponsorTokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'repayAmount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'SponsorRepayRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'sponsorTokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'swept',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'remaining',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'SponsorRepaySwept',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'UsernameMinted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Withdrawn',
  },
  { type: 'error', inputs: [], name: 'BadNonce' },
  { type: 'error', inputs: [], name: 'BadSig' },
  { type: 'error', inputs: [], name: 'Expired' },
  { type: 'error', inputs: [], name: 'InsufficientBalance' },
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'optionType', internalType: 'uint16', type: 'uint16' }],
    name: 'InvalidOptionType',
  },
  { type: 'error', inputs: [], name: 'LzTokenUnavailable' },
  { type: 'error', inputs: [], name: 'NoFee' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
  },
  { type: 'error', inputs: [], name: 'NoSession' },
  { type: 'error', inputs: [], name: 'NoWithdraw' },
  { type: 'error', inputs: [], name: 'NotCa' },
  {
    type: 'error',
    inputs: [{ name: 'msgValue', internalType: 'uint256', type: 'uint256' }],
    name: 'NotEnoughNative',
  },
  { type: 'error', inputs: [], name: 'NotMainnet' },
  {
    type: 'error',
    inputs: [{ name: 'addr', internalType: 'address', type: 'address' }],
    name: 'OnlyEndpoint',
  },
  { type: 'error', inputs: [], name: 'OnlyLZ' },
  {
    type: 'error',
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'OnlyPeer',
  },
  { type: 'error', inputs: [], name: 'Replayed' },
  { type: 'error', inputs: [], name: 'SpendLimitTooHigh' },
  { type: 'error', inputs: [], name: 'Unauth' },
  { type: 'error', inputs: [], name: 'UnauthorizedSelector' },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
  { type: 'error', inputs: [], name: 'ZeroKey' },
  { type: 'error', inputs: [], name: 'ZeroOwner' },
  { type: 'error', inputs: [], name: 'ZeroSibling' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileLens
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileLensAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_cawProfile', internalType: 'address', type: 'address' },
      { name: '_cawProfileMinter', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [
      { name: '', internalType: 'contract ICawProfile', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfileMinter',
    outputs: [
      { name: '', internalType: 'contract ICawProfileMinter', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'profilesWithNetworkState',
    outputs: [
      {
        name: 'result',
        internalType: 'struct CawProfileLens.TokenWithNetworkState[]',
        type: 'tuple[]',
        components: [
          { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'ownerBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'withdrawable', internalType: 'uint256', type: 'uint256' },
          { name: 'authenticated', internalType: 'bool', type: 'bool' },
          { name: 'withdrawFeeLocked', internalType: 'bool', type: 'bool' },
          {
            name: 'lockedWithdrawFee',
            internalType: 'uint256',
            type: 'uint256',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'username', internalType: 'string', type: 'string' }],
    name: 'tokenByUsername',
    outputs: [
      {
        name: 'result',
        internalType: 'struct CawProfileLens.Token',
        type: 'tuple',
        components: [
          { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'ownerBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'withdrawable', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'tokens',
    outputs: [
      {
        name: 'result',
        internalType: 'struct CawProfileLens.Token[]',
        type: 'tuple[]',
        components: [
          { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'ownerBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'withdrawable', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileMarketplace
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileMarketplaceAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_cawProfile', internalType: 'address', type: 'address' },
      { name: '_lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: '_paymentTokens', internalType: 'address[]', type: 'address[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'ANTI_SNIPE_DURATION',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'AUCTION_DEFAULT_GRACE',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'MIN_BID_INCREMENT_BPS',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'offerId', internalType: 'uint256', type: 'uint256' }],
    name: 'acceptOffer',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'allowedPaymentTokens',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'buy',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'listingId', internalType: 'uint256', type: 'uint256' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'buyWithToken',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'cancelListing',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'offerId', internalType: 'uint256', type: 'uint256' }],
    name: 'cancelOffer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'offerId', internalType: 'uint256', type: 'uint256' },
      { name: 'recipient', internalType: 'address', type: 'address' },
    ],
    name: 'cancelOfferTo',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [
      {
        name: '',
        internalType: 'contract ICawProfileTransfer',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      {
        name: 'listingType',
        internalType: 'enum CawProfileMarketplace.ListingType',
        type: 'uint8',
      },
      { name: 'paymentToken', internalType: 'address', type: 'address' },
      { name: 'startPrice', internalType: 'uint256', type: 'uint256' },
      { name: 'endPrice', internalType: 'uint256', type: 'uint256' },
      { name: 'duration', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'createListing',
    outputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'paymentToken', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'duration', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'createOfferERC20',
    outputs: [{ name: 'offerId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'duration', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'createOfferETH',
    outputs: [{ name: 'offerId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'getCurrentPrice',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'listingByTokenId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'listings',
    outputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'seller', internalType: 'address', type: 'address' },
      { name: 'paymentToken', internalType: 'address', type: 'address' },
      {
        name: 'listingType',
        internalType: 'enum CawProfileMarketplace.ListingType',
        type: 'uint8',
      },
      { name: 'startPrice', internalType: 'uint256', type: 'uint256' },
      { name: 'endPrice', internalType: 'uint256', type: 'uint256' },
      { name: 'startTime', internalType: 'uint64', type: 'uint64' },
      { name: 'endTime', internalType: 'uint64', type: 'uint64' },
      { name: 'highestBid', internalType: 'uint256', type: 'uint256' },
      { name: 'highestBidder', internalType: 'address', type: 'address' },
      { name: 'active', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'lzDestId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextListingId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextOfferId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'offers',
    outputs: [
      { name: 'offerer', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'paymentToken', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'active', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'address', type: 'address' }],
    name: 'pendingPayouts',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'address', type: 'address' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'pendingReturns',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'placeBid',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'listingId', internalType: 'uint256', type: 'uint256' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'placeBidWithToken',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'reclaimBid',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'reclaimListing',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'refundDefaultedAuction',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'settleAuction',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'listingId', internalType: 'uint256', type: 'uint256' }],
    name: 'withdrawBid',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'listingId', internalType: 'uint256', type: 'uint256' },
      { name: 'recipient', internalType: 'address', type: 'address' },
    ],
    name: 'withdrawBidTo',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'withdrawPayouts',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'recipient', internalType: 'address', type: 'address' }],
    name: 'withdrawPayoutsTo',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'bidder',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'AuctionDefaulted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'winner',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'price',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'AuctionSettled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'bidder',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'BidPlaced',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'bidder',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'BidReclaimed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'bidder',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'BidWithdrawn',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'seller',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'listingType',
        internalType: 'enum CawProfileMarketplace.ListingType',
        type: 'uint8',
        indexed: false,
      },
      {
        name: 'paymentToken',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'startPrice',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Listed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'ListingCancelled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'offerId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'seller',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'buyer',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'price',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'paymentToken',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'OfferAccepted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'offerId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'OfferCancelled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'offerId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'offerer',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'paymentToken',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'expiry',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'OfferCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'seller',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'PayoutQueued',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'seller',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'recipient',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'amount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'PayoutWithdrawn',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'listingId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'buyer',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'price',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'paymentToken',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'Sale',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileMinter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileMinterAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_caw', internalType: 'address', type: 'address' },
      { name: '_cawProfiles', internalType: 'address', type: 'address' },
      { name: '_router', internalType: 'address', type: 'address' },
      { name: '_pathwayExpander', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [],
    name: 'DOMAIN_SEPARATOR',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'WETH',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'level', internalType: 'uint8', type: 'uint8' },
      { name: 'verifier', internalType: 'address', type: 'address' },
    ],
    name: 'addKycVerifier',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'permitNonce', internalType: 'uint256', type: 'uint256' },
      { name: 'sig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'authenticateSponsored',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenOwner', internalType: 'address', type: 'address' },
    ],
    name: 'checkWithdrawAllowed',
    outputs: [],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'username', internalType: 'string', type: 'string' }],
    name: 'costOfName',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'permitNonce', internalType: 'uint256', type: 'uint256' },
      { name: 'sig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'depositForSponsored',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'swapEthAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'minCawOut', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'depositZap',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'string', type: 'string' }],
    name: 'idByUsername',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_input', internalType: 'string', type: 'string' }],
    name: 'isValidUsername',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [{ name: 'level', internalType: 'uint8', type: 'uint8' }],
    name: 'kycVerifierFor',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    name: 'kycVerifiers',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndAuth',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'mintAndAuthAndQuickSign',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndAuthFor',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDeposit',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'mintAndDepositAndQuickSign',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'swapEthAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'minCawOut', internalType: 'uint256', type: 'uint256' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'spendLimit', internalType: 'uint256', type: 'uint256' },
      { name: 'perActionTipRate', internalType: 'uint64', type: 'uint64' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDepositAndQuickSignZap',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDepositFor',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'kycLevel', internalType: 'uint8', type: 'uint8' },
    ],
    name: 'mintAndDepositLocked',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'permitNonce', internalType: 'uint256', type: 'uint256' },
      { name: 'sig', internalType: 'bytes', type: 'bytes' },
      { name: 'kycLevel', internalType: 'uint8', type: 'uint8' },
      { name: 'sponsorTokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'repayAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDepositSponsored',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'swapEthAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'minCawOut', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintAndDepositZap',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'recipient', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mintFor',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'mintedAt',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'pathwayExpander',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'swapRouter',
    outputs: [
      { name: '', internalType: 'contract ISwapRouter', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint32', type: 'uint32' }],
    name: 'unlockWithdraw',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'withdrawKycLevel',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'level', internalType: 'uint8', type: 'uint8', indexed: true },
      {
        name: 'verifier',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'KycVerifierAdded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'sponsorTokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'repayAmount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'depositAmount',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'SponsorRepaySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'tokenId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'WithdrawUnlocked',
  },
  { type: 'error', inputs: [], name: 'AlreadyUnlocked' },
  { type: 'error', inputs: [], name: 'KycNotConfigured' },
  { type: 'error', inputs: [], name: 'KycRequired' },
  { type: 'error', inputs: [], name: 'LevelAlreadySet' },
  { type: 'error', inputs: [], name: 'NotPathwayExpander' },
  { type: 'error', inputs: [], name: 'NotTokenOwner' },
  { type: 'error', inputs: [], name: 'WithdrawTimelocked' },
  { type: 'error', inputs: [], name: 'ZeroAddr' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileQuoter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileQuoterAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_cawProfile', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'authenticateQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'broadcastAllowFreeAuthQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawProfile',
    outputs: [
      {
        name: '',
        internalType: 'contract ICawProfileForQuoter',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'depositQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'depositZapQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'effectiveWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
    ],
    name: 'mintAndAuthAndQuickSignQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'mintAndAuthQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
    ],
    name: 'mintAndDepositAndQuickSignQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'sessionKey', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'mintAndDepositAndQuickSignZapQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'depositAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'mintAndDepositQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'mintAndDepositZapQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'bool', type: 'bool' },
    ],
    name: 'mintQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'syncTransferQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'updateOwnerQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'withdrawQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawProfileURI
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawProfileUriAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_fontDataA', internalType: 'address', type: 'address' },
      { name: '_fontDataB', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'description',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'fontDataA',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'fontDataB',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'name', internalType: 'string', type: 'string' }],
    name: 'generate',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CivicKycVerifier
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const civicKycVerifierAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_civic', internalType: 'address', type: 'address' },
      { name: '_network', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'civic',
    outputs: [
      {
        name: '',
        internalType: 'contract IGatewayTokenVerifier',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'gatekeeperNetwork',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'isVerified',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawActionsCheckpoints
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawActionsCheckpointsAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'networkHashAtCheckpoint',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawFontData
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawFontDataAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'DATA',
    outputs: [{ name: '', internalType: 'bytes', type: 'bytes' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfile
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'CAW',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'authenticated',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'lockedWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'index', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'index', internalType: 'uint256', type: 'uint256' }],
    name: 'usernames',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'withdrawFeeLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint32', type: 'uint32' }],
    name: 'withdrawable',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfileForAuthFeePropagation
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileForAuthFeePropagationAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'broadcastAllowFreeAuth',
    outputs: [],
    stateMutability: 'payable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfileForQuoter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileForQuoterAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'authenticated',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'lockedWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawNetworkId', internalType: 'uint32', type: 'uint32' },
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
      { name: 'n', internalType: 'uint256', type: 'uint256' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: '_payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'lzQuote',
    outputs: [
      {
        name: 'quote',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'mainnetLzId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'networkManager',
    outputs: [
      { name: '', internalType: 'contract CawNetworkManager', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'pendingTransferUpdates',
    outputs: [
      { name: '', internalType: 'uint32[]', type: 'uint32[]' },
      { name: '', internalType: 'address[]', type: 'address[]' },
      { name: '', internalType: 'uint64[]', type: 'uint64[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'withdrawFeeLocked',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfileForTipTargetPropagation
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileForTipTargetPropagationAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'networkId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'broadcastTipTarget',
    outputs: [],
    stateMutability: 'payable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfileMinter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileMinterAbi = [
  {
    type: 'function',
    inputs: [{ name: 'username', internalType: 'string', type: 'string' }],
    name: 'idByUsername',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawProfileTransfer
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawProfileTransferAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'getApproved',
    outputs: [{ name: 'operator', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'operator', internalType: 'address', type: 'address' },
    ],
    name: 'isApprovedForAll',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'safeTransferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'safeTransferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'operator', internalType: 'address', type: 'address' },
      { name: 'approved', internalType: 'bool', type: 'bool' },
    ],
    name: 'setApprovalForAll',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'interfaceId', internalType: 'bytes4', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferAndSync',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'approved',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'tokenId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'operator',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      { name: 'approved', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'ApprovalForAll',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'tokenId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
    ],
    name: 'Transfer',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawWithdrawGate
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawWithdrawGateAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenOwner', internalType: 'address', type: 'address' },
    ],
    name: 'checkWithdrawAllowed',
    outputs: [],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IGatewayTokenVerifier
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iGatewayTokenVerifierAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'network', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'verifyToken',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IKycVerifier
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iKycVerifierAbi = [
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'isVerified',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MintableCaw
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mintableCawAbi = [
  { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', internalType: 'address', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', internalType: 'uint8', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'subtractedValue', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'decreaseAllowance',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'addedValue', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'increaseAllowance',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'account', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'spender',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'Transfer',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SmartEOA
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const smartEoaAbi = [
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [{ name: 'sig', internalType: 'bytes', type: 'bytes' }],
    name: '_decodeWebAuthn',
    outputs: [
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '', internalType: 'bytes', type: 'bytes' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
      { name: '', internalType: 'bytes32', type: 'bytes32' },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'digest', internalType: 'bytes32', type: 'bytes32' },
      { name: 'sig', internalType: 'bytes', type: 'bytes' },
    ],
    name: '_verifyWebAuthnExternal',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'newPubkeyX', internalType: 'bytes32', type: 'bytes32' },
      { name: 'newPubkeyY', internalType: 'bytes32', type: 'bytes32' },
      { name: 'callerSig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'addPasskey',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'targetPubkeyHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'callerSig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'cancelPendingPasskey',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'verifyingContract', internalType: 'address', type: 'address' },
      { name: 'actionType', internalType: 'uint8', type: 'uint8' },
    ],
    name: 'consumeNonce',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'pubkeyX', internalType: 'bytes32', type: 'bytes32' },
      { name: 'pubkeyY', internalType: 'bytes32', type: 'bytes32' },
      { name: 'ecdsaFallbackAddr', internalType: 'address', type: 'address' },
      {
        name: 'minterContract',
        internalType: 'address payable',
        type: 'address',
      },
      { name: 'mintCalldata', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'initialize',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'digest', internalType: 'bytes32', type: 'bytes32' },
      { name: 'sig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'isValidSignature',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'managementNonceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'verifyingContract', internalType: 'address', type: 'address' },
      { name: 'actionType', internalType: 'uint8', type: 'uint8' },
    ],
    name: 'nonceOf',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'targetPubkeyHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'callerSig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'removePasskey',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'newFallback', internalType: 'address', type: 'address' },
      { name: 'callerSig', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'rotateEcdsaFallback',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'newFallback',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'EcdsaFallbackRotated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'account',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
    ],
    name: 'Initialized',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'pubkeyHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'PasskeyActivated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'pubkeyHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'validFrom',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'PasskeyAdded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'pubkeyHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'PasskeyCancelled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'pubkeyHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'PasskeyRemoved',
  },
  { type: 'error', inputs: [], name: 'AlreadyInitialized' },
  { type: 'error', inputs: [], name: 'InvalidCallerSig' },
  { type: 'error', inputs: [], name: 'MinterCallFailed' },
  { type: 'error', inputs: [], name: 'NotInitialized' },
  { type: 'error', inputs: [], name: 'NotPermitted' },
  { type: 'error', inputs: [], name: 'PasskeyAlreadyEnrolled' },
  { type: 'error', inputs: [], name: 'PasskeyNotFound' },
  { type: 'error', inputs: [], name: 'PasskeyNotPending' },
  { type: 'error', inputs: [], name: 'SelfRemovalRequiresLastActive' },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
] as const
