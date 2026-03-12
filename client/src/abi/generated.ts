//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawActions
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawActionsAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_cawNames', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
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
      {
        name: 'reason',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
    ],
    name: 'ActionRejected',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'actions',
        internalType: 'struct CawActions.ActionData[]',
        type: 'tuple[]',
        components: [
          {
            name: 'actionType',
            internalType: 'enum CawActions.ActionType',
            type: 'uint8',
          },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
        indexed: false,
      },
    ],
    name: 'ActionsProcessed',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawName',
    outputs: [
      { name: '', internalType: 'contract CawNameL2', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'clientActionCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'clientCurrentHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'clientHashAtCheckpoint',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
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
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplicationCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplicationDestinations',
    outputs: [
      {
        name: '',
        internalType: 'struct ReplicationDestination[]',
        type: 'tuple[]',
        components: [
          { name: 'target', internalType: 'address', type: 'address' },
          { name: 'eid', internalType: 'uint32', type: 'uint32' },
        ],
      },
    ],
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
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'processAction',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      {
        name: 'data',
        internalType: 'struct CawActions.MultiActionData',
        type: 'tuple',
        components: [
          {
            name: 'actions',
            internalType: 'struct CawActions.ActionData[]',
            type: 'tuple[]',
            components: [
              {
                name: 'actionType',
                internalType: 'enum CawActions.ActionType',
                type: 'uint8',
              },
              { name: 'senderId', internalType: 'uint32', type: 'uint32' },
              { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
              {
                name: 'receiverCawonce',
                internalType: 'uint32',
                type: 'uint32',
              },
              { name: 'clientId', internalType: 'uint32', type: 'uint32' },
              { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
              {
                name: 'recipients',
                internalType: 'uint32[]',
                type: 'uint32[]',
              },
              { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
              { name: 'text', internalType: 'string', type: 'string' },
            ],
          },
          { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
          { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
          { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
        ],
      },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      {
        name: 'withdrawLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
      {
        name: 'replicationLzTokenAmount',
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      {
        name: 'data',
        internalType: 'struct CawActions.MultiActionData',
        type: 'tuple',
        components: [
          {
            name: 'actions',
            internalType: 'struct CawActions.ActionData[]',
            type: 'tuple[]',
            components: [
              {
                name: 'actionType',
                internalType: 'enum CawActions.ActionType',
                type: 'uint8',
              },
              { name: 'senderId', internalType: 'uint32', type: 'uint32' },
              { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
              {
                name: 'receiverCawonce',
                internalType: 'uint32',
                type: 'uint32',
              },
              { name: 'clientId', internalType: 'uint32', type: 'uint32' },
              { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
              {
                name: 'recipients',
                internalType: 'uint32[]',
                type: 'uint32[]',
              },
              { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
              { name: 'text', internalType: 'string', type: 'string' },
            ],
          },
          { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
          { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
          { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
        ],
      },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'replicationQuote',
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
      { name: 'chainCount', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'replicator',
    outputs: [
      {
        name: '',
        internalType: 'contract CawActionsReplicator',
        type: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'validatorId', internalType: 'uint32', type: 'uint32' },
      {
        name: 'data',
        internalType: 'struct CawActions.MultiActionData',
        type: 'tuple',
        components: [
          {
            name: 'actions',
            internalType: 'struct CawActions.ActionData[]',
            type: 'tuple[]',
            components: [
              {
                name: 'actionType',
                internalType: 'enum CawActions.ActionType',
                type: 'uint8',
              },
              { name: 'senderId', internalType: 'uint32', type: 'uint32' },
              { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
              {
                name: 'receiverCawonce',
                internalType: 'uint32',
                type: 'uint32',
              },
              { name: 'clientId', internalType: 'uint32', type: 'uint32' },
              { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
              {
                name: 'recipients',
                internalType: 'uint32[]',
                type: 'uint32[]',
              },
              { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
              { name: 'text', internalType: 'string', type: 'string' },
            ],
          },
          { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
          { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
          { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
        ],
      },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      {
        name: 'withdrawLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
      {
        name: 'replicationLzTokenAmount',
        internalType: 'uint256',
        type: 'uint256',
      },
    ],
    name: 'safeProcessActions',
    outputs: [
      {
        name: 'successfulActions',
        internalType: 'struct CawActions.ActionData[]',
        type: 'tuple[]',
        components: [
          {
            name: 'actionType',
            internalType: 'enum CawActions.ActionType',
            type: 'uint8',
          },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
      { name: 'rejections', internalType: 'string[]', type: 'string[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: '_replicator', internalType: 'address', type: 'address' }],
    name: 'setReplicator',
    outputs: [],
    stateMutability: 'nonpayable',
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
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'data',
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
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
    ],
    name: 'verifySignature',
    outputs: [],
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawActionsArchive
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawActionsArchiveAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_endpoint', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
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
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'sourceChainId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'guid', internalType: 'bytes32', type: 'bytes32', indexed: true },
      { name: 'data', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'ActionsArchived',
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawActionsReplicator
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawActionsReplicatorAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: '_cawActions', internalType: 'address', type: 'address' },
      { name: '_cawNameL2', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
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
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'checkpointId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'offset',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'count',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MigrationBatchProcessed',
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
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'destEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'count',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'PartialCheckpointMigrated',
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
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: true },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'PeerUpdated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'destEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'payloadSize',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
    ],
    name: 'Replicated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'destEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'reason',
        internalType: 'string',
        type: 'string',
        indexed: false,
      },
    ],
    name: 'ReplicationFailed',
  },
  {
    type: 'function',
    inputs: [],
    name: 'RECEIVE_GAS_LIMIT',
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
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawNameL2',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'clientPeers',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'clientReplicationEnabled',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'clientReplications',
    outputs: [
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
      { name: 'options', internalType: 'bytes', type: 'bytes' },
      { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
      { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'doLzSend',
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
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplicationCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplicationDestinations',
    outputs: [
      {
        name: '',
        internalType: 'struct ReplicationDestination[]',
        type: 'tuple[]',
        components: [
          { name: 'target', internalType: 'address', type: 'address' },
          { name: 'eid', internalType: 'uint32', type: 'uint32' },
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
      {
        name: 'params',
        internalType: 'struct CawActionsReplicator.MigrationParams',
        type: 'tuple',
        components: [
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'destEid', internalType: 'uint32', type: 'uint32' },
          { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
          { name: 'offset', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
        ],
      },
      {
        name: 'actions',
        internalType: 'struct ICawActionsForReplicator.ActionData[]',
        type: 'tuple[]',
        components: [
          { name: 'actionType', internalType: 'uint8', type: 'uint8' },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
      { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
      { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 'allR', internalType: 'bytes32[256]', type: 'bytes32[256]' },
    ],
    name: 'migrateHistoricalBatch',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      {
        name: 'actions',
        internalType: 'struct ICawActionsForReplicator.ActionData[]',
        type: 'tuple[]',
        components: [
          { name: 'actionType', internalType: 'uint8', type: 'uint8' },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
      { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
      { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
      { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
    ],
    name: 'migratePartialCheckpoint',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'migrationBitmap',
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
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'actionCount', internalType: 'uint256', type: 'uint256' },
      { name: 'avgTextLength', internalType: 'uint256', type: 'uint256' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'quoteMigration',
    outputs: [
      {
        name: 'fee',
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'quoteReplication',
    outputs: [
      {
        name: 'totalFee',
        internalType: 'struct MessagingFee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', internalType: 'uint256', type: 'uint256' },
          { name: 'lzTokenFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
      { name: 'chainCount', internalType: 'uint256', type: 'uint256' },
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
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'replicate',
    outputs: [],
    stateMutability: 'payable',
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
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'updatePeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawClientManager
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawClientManagerAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_buyAndBurn', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'client',
        internalType: 'struct CawClient',
        type: 'tuple',
        components: [
          { name: 'id', internalType: 'uint32', type: 'uint32' },
          { name: 'feeAddress', internalType: 'address', type: 'address' },
          { name: 'ownerAddress', internalType: 'address', type: 'address' },
          { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
          { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
          { name: 'authFee', internalType: 'uint256', type: 'uint256' },
        ],
        indexed: false,
      },
    ],
    name: 'ClientCreated',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: true },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'ClientReplicationAdded',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'enabled', internalType: 'bool', type: 'bool', indexed: false },
    ],
    name: 'ClientReplicationEnabledChanged',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: true },
    ],
    name: 'ClientReplicationRemoved',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'addReplication',
    outputs: [],
    stateMutability: 'payable',
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
    name: 'cawName',
    outputs: [{ name: '', internalType: 'contract ICawName', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
    ],
    name: 'changeOwner',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'clientReplicationEnabled',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '', internalType: 'uint32', type: 'uint32' },
      { name: '', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'clientReplications',
    outputs: [
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'clients',
    outputs: [
      { name: 'id', internalType: 'uint32', type: 'uint32' },
      { name: 'feeAddress', internalType: 'address', type: 'address' },
      { name: 'ownerAddress', internalType: 'address', type: 'address' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
      { name: 'authFee', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'feeAddress', internalType: 'address', type: 'address' },
      { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
      { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
      { name: 'authFee', internalType: 'uint256', type: 'uint256' },
      { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'createClient',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'defaultL2Eid',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getAuthFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getAuthFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getClient',
    outputs: [
      {
        name: '',
        internalType: 'struct CawClient',
        type: 'tuple',
        components: [
          { name: 'id', internalType: 'uint32', type: 'uint32' },
          { name: 'feeAddress', internalType: 'address', type: 'address' },
          { name: 'ownerAddress', internalType: 'address', type: 'address' },
          { name: 'withdrawFee', internalType: 'uint256', type: 'uint256' },
          { name: 'depositFee', internalType: 'uint256', type: 'uint256' },
          { name: 'mintFee', internalType: 'uint256', type: 'uint256' },
          { name: 'authFee', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getClientOwner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getDepositFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getDepositFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getMintFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getMintFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplicationCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getReplications',
    outputs: [
      {
        name: '',
        internalType: 'struct ReplicationDestination[]',
        type: 'tuple[]',
        components: [
          { name: 'target', internalType: 'address', type: 'address' },
          { name: 'eid', internalType: 'uint32', type: 'uint32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getWithdrawFee',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'getWithdrawFeeAndAddress',
    outputs: [
      { name: '', internalType: 'uint256', type: 'uint256' },
      { name: '', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextClientId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
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
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'removeReplication',
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
    inputs: [
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'replicationSyncQuote',
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setAuthFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_cawName', internalType: 'address', type: 'address' },
      { name: '_defaultL2Eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'setCawName',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDepositFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'feeAddress', internalType: 'address', type: 'address' },
    ],
    name: 'setFeeAddress',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setMintFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'enabled', internalType: 'bool', type: 'bool' },
    ],
    name: 'setReplicationEnabled',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'fee', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setWithdrawFee',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawName
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNameAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_caw', internalType: 'address', type: 'address' },
      { name: '_gui', internalType: 'address', type: 'address' },
      { name: '_buyAndBurn', internalType: 'address', type: 'address' },
      { name: '_clientManager', internalType: 'address', type: 'address' },
      { name: '_endpoint', internalType: 'address', type: 'address' },
      { name: 'mainnetEid', internalType: 'uint32', type: 'uint32' },
    ],
    stateMutability: 'nonpayable',
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
  { type: 'fallback', stateMutability: 'payable' },
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
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzEthAmount', internalType: 'uint256', type: 'uint256' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: '_updateNewOwners',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'addToBalanceSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
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
    inputs: [],
    name: 'authSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
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
    inputs: [],
    name: 'cawNameL2',
    outputs: [
      { name: '', internalType: 'contract CawNameL2', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'clientManager',
    outputs: [
      { name: '', internalType: 'contract CawClientManager', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
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
    inputs: [{ name: 'selector', internalType: 'bytes4', type: 'bytes4' }],
    name: 'gasLimitFor',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
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
      { name: 'token', internalType: 'uint32', type: 'uint32' },
      { name: 'index', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'getChosenChainIdAtIndex',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
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
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
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
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
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
    inputs: [],
    name: 'mintSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
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
    inputs: [],
    name: 'peerWithMaxPendingTransfers',
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
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'pendingTransferEnd',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    name: 'pendingTransferStart',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
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
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'lzDestId', internalType: 'uint32', type: 'uint32' }],
    name: 'pendingTransferUpdates',
    outputs: [
      { name: '', internalType: 'uint32[]', type: 'uint32[]' },
      { name: '', internalType: 'address[]', type: 'address[]' },
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
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_peer', internalType: 'address', type: 'address' },
    ],
    name: 'setL2Peer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_minter', internalType: 'address', type: 'address' }],
    name: 'setMinter',
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
    inputs: [],
    name: 'setReplicationPeerSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_gui', internalType: 'address', type: 'address' }],
    name: 'setUriGenerator',
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'replicationIndex', internalType: 'uint256', type: 'uint256' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'syncReplication',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'syncReplicationInternal',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'syncReplicationRemoval',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenId', internalType: 'uint32', type: 'uint32' }],
    name: 'token',
    outputs: [
      {
        name: '',
        internalType: 'struct CawName.Token',
        type: 'tuple',
        components: [
          { name: 'withdrawable', internalType: 'uint256', type: 'uint256' },
          { name: 'ownerBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'owner', internalType: 'address', type: 'address' },
        ],
      },
    ],
    stateMutability: 'view',
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
    inputs: [{ name: 'user', internalType: 'address', type: 'address' }],
    name: 'tokens',
    outputs: [
      {
        name: '',
        internalType: 'struct CawName.Token[]',
        type: 'tuple[]',
        components: [
          { name: 'withdrawable', internalType: 'uint256', type: 'uint256' },
          { name: 'ownerBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
          { name: 'username', internalType: 'string', type: 'string' },
          { name: 'owner', internalType: 'address', type: 'address' },
        ],
      },
    ],
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
    name: 'transferUpdateLimit',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'updateOwnersSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'lzDestId', internalType: 'uint32', type: 'uint32' }],
    name: 'updatesNeededForPeer',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'uriGenerator',
    outputs: [
      { name: '', internalType: 'contract CawNameURI', type: 'address' },
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
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'withdraw',
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
  { type: 'receive', stateMutability: 'payable' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawNameL2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNameL2Abi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_endpointId', internalType: 'uint32', type: 'uint32' },
      { name: '_endpoint', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
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
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'cawClientId',
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
        name: 'clientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'archiveEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: true,
      },
      {
        name: 'target',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'ReplicationPeerSet',
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
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'auth',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'owners', internalType: 'address[]', type: 'address[]' },
    ],
    name: 'authenticateAndUpdateOwners',
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
    name: 'cawActions',
    outputs: [
      { name: '', internalType: 'contract ICawActions', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'cawActionsReplicator',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
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
    inputs: [],
    name: 'cawName',
    outputs: [{ name: '', internalType: 'contract CawName', type: 'address' }],
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
    inputs: [
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'cawClientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'amount', internalType: 'uint256', type: 'uint256' },
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'owners', internalType: 'address[]', type: 'address[]' },
    ],
    name: 'depositAndUpdateOwners',
    outputs: [],
    stateMutability: 'nonpayable',
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
    inputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    name: 'functionSigs',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'selector', internalType: 'bytes4', type: 'bytes4' }],
    name: 'gasLimitFor',
    outputs: [{ name: '', internalType: 'uint128', type: 'uint128' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' }],
    name: 'getTokens',
    outputs: [
      {
        name: '',
        internalType: 'struct CawNameL2.Token[]',
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
    inputs: [],
    name: 'layer1EndpointId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
      { name: 'payload', internalType: 'bytes', type: 'bytes' },
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
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'username', internalType: 'string', type: 'string' },
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
      { name: 'tokenIds', internalType: 'uint32[]', type: 'uint32[]' },
      { name: 'owners', internalType: 'address[]', type: 'address[]' },
    ],
    name: 'mintAndUpdateOwners',
    outputs: [],
    stateMutability: 'nonpayable',
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
    inputs: [{ name: '_cawActions', internalType: 'address', type: 'address' }],
    name: 'setCawActions',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_replicator', internalType: 'address', type: 'address' }],
    name: 'setCawActionsReplicator',
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
      { name: 'peer', internalType: 'address payable', type: 'address' },
      { name: '_bypassLZ', internalType: 'bool', type: 'bool' },
    ],
    name: 'setL1Peer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
      { name: 'newOwner', internalType: 'address', type: 'address' },
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'setReplicationPeer',
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawNameMinter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNameMinterAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_caw', internalType: 'address', type: 'address' },
      { name: '_cawNames', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
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
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'username', internalType: 'string', type: 'string' },
      { name: 'lzTokenAmount', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'payable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CawNameQuoter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNameQuoterAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_cawName', internalType: 'address', type: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
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
    inputs: [],
    name: 'cawName',
    outputs: [
      { name: '', internalType: 'contract ICawNameForQuoter', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'syncReplicationQuote',
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
    inputs: [{ name: 'payInLzToken', internalType: 'bool', type: 'bool' }],
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
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
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
// CawNameURI
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const cawNameUriAbi = [
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
    type: 'function',
    inputs: [],
    name: 'description',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'name', internalType: 'string', type: 'string' }],
    name: 'generate',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
    stateMutability: 'view',
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
    inputs: [],
    name: 'renounceOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '_description', internalType: 'string', type: 'string' }],
    name: 'setDescription',
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawActionsForReplicator
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawActionsForReplicatorAbi = [
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'clientActionCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'clientId', internalType: 'uint32', type: 'uint32' }],
    name: 'clientCurrentHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'checkpointId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'clientHashAtCheckpoint',
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
    inputs: [
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'data',
        internalType: 'struct ICawActionsForReplicator.ActionData',
        type: 'tuple',
        components: [
          { name: 'actionType', internalType: 'uint8', type: 'uint8' },
          { name: 'senderId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverId', internalType: 'uint32', type: 'uint32' },
          { name: 'receiverCawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'clientId', internalType: 'uint32', type: 'uint32' },
          { name: 'cawonce', internalType: 'uint32', type: 'uint32' },
          { name: 'recipients', internalType: 'uint32[]', type: 'uint32[]' },
          { name: 'amounts', internalType: 'uint64[]', type: 'uint64[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
    ],
    name: 'verifySignature',
    outputs: [],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawActionsReplicator
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawActionsReplicatorAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'destEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
    ],
    name: 'updatePeer',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawName
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawNameAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'syncReplicationInternal',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'archiveEid', internalType: 'uint32', type: 'uint32' },
      { name: 'target', internalType: 'address', type: 'address' },
      { name: 'lzDestId', internalType: 'uint32', type: 'uint32' },
      { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
    ],
    name: 'syncReplicationQuote',
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ICawNameForQuoter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iCawNameForQuoterAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'addToBalanceSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'authSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'tokenId', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'authenticated',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'clientManager',
    outputs: [
      { name: '', internalType: 'contract CawClientManager', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'selector', internalType: 'bytes4', type: 'bytes4' },
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
    name: 'mintSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'peerWithMaxPendingTransfers',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
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
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'lzDestId', internalType: 'uint32', type: 'uint32' }],
    name: 'pendingTransferUpdates',
    outputs: [
      { name: '', internalType: 'uint32[]', type: 'uint32[]' },
      { name: '', internalType: 'address[]', type: 'address[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'setReplicationPeerSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'updateOwnersSelector',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MintableCaw
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mintableCawAbi = [
  { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
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
] as const
