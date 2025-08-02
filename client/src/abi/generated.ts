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
          { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
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
    name: 'currentCawonceMap',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'currentHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
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
    inputs: [],
    name: 'getCurrentHash',
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
          { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
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
              { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
              { name: 'text', internalType: 'string', type: 'string' },
            ],
          },
          { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
          { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
          { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
        ],
      },
      {
        name: 'lzTokenAmountForWithdraws',
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
              { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
              { name: 'text', internalType: 'string', type: 'string' },
            ],
          },
          { name: 'v', internalType: 'uint8[]', type: 'uint8[]' },
          { name: 'r', internalType: 'bytes32[]', type: 'bytes32[]' },
          { name: 's', internalType: 'bytes32[]', type: 'bytes32[]' },
        ],
      },
      {
        name: 'lzTokenAmountForWithdraws',
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
          { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
          { name: 'text', internalType: 'string', type: 'string' },
        ],
      },
      { name: 'rejections', internalType: 'string[]', type: 'string[]' },
    ],
    stateMutability: 'payable',
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
          { name: 'amounts', internalType: 'uint128[]', type: 'uint128[]' },
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
        name: 'nextClientId',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
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
    inputs: [{ name: '_endpoint', internalType: 'address', type: 'address' }],
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
    name: 'getTokens',
    inputs: [
      {
        internalType: 'uint32[]',
        name: 'tokenIds',
        type: 'uint32[]'
      }
    ],
    outputs: [
      {
        // Tuple since it returns an array of structs
        internalType: 'struct Token[]',
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'tokenId',    internalType: 'uint256', type: 'uint256' },
          { name: 'balance',    internalType: 'uint256', type: 'uint256' },
          { name: 'username',   internalType: 'string',  type: 'string'  },
          { name: 'cawBalance', internalType: 'uint256', type: 'uint256' },
          { name: 'nextCawonce',internalType: 'uint256', type: 'uint256' }
        ]
      }
    ],
    stateMutability: 'view'
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
// DVNOptions
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const dvnOptionsAbi = [
  { type: 'error', inputs: [], name: 'DVN_InvalidDVNIdx' },
  {
    type: 'error',
    inputs: [{ name: 'cursor', internalType: 'uint256', type: 'uint256' }],
    name: 'DVN_InvalidDVNOptions',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// EIP712
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const eip712Abi = [
  { type: 'error', inputs: [], name: 'InvalidShortString' },
  {
    type: 'error',
    inputs: [{ name: 'str', internalType: 'string', type: 'string' }],
    name: 'StringTooLong',
  },
  { type: 'event', anonymous: false, inputs: [], name: 'EIP712DomainChanged' },
  {
    type: 'function',
    inputs: [],
    name: 'eip712Domain',
    outputs: [
      { name: 'fields', internalType: 'bytes1', type: 'bytes1' },
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'version', internalType: 'string', type: 'string' },
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'verifyingContract', internalType: 'address', type: 'address' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
      { name: 'extensions', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ERC165
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const erc165Abi = [
  {
    type: 'function',
    inputs: [{ name: 'interfaceId', internalType: 'bytes4', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ERC20
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const erc20Abi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'name_', internalType: 'string', type: 'string' },
      { name: 'symbol_', internalType: 'string', type: 'string' },
    ],
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

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ERC721
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const erc721Abi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'name_', internalType: 'string', type: 'string' },
      { name: 'symbol_', internalType: 'string', type: 'string' },
    ],
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
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
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
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ERC721Enumerable
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const erc721EnumerableAbi = [
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
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
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
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ExecutorOptions
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const executorOptionsAbi = [
  { type: 'error', inputs: [], name: 'Executor_InvalidLzComposeOption' },
  { type: 'error', inputs: [], name: 'Executor_InvalidLzReceiveOption' },
  { type: 'error', inputs: [], name: 'Executor_InvalidNativeDropOption' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC165
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc165Abi = [
  {
    type: 'function',
    inputs: [{ name: 'interfaceId', internalType: 'bytes4', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC20
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc20Abi = [
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

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC20Metadata
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc20MetadataAbi = [
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

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC20Permit
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc20PermitAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'DOMAIN_SEPARATOR',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'owner', internalType: 'address', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'spender', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'permit',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC5267
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc5267Abi = [
  { type: 'event', anonymous: false, inputs: [], name: 'EIP712DomainChanged' },
  {
    type: 'function',
    inputs: [],
    name: 'eip712Domain',
    outputs: [
      { name: 'fields', internalType: 'bytes1', type: 'bytes1' },
      { name: 'name', internalType: 'string', type: 'string' },
      { name: 'version', internalType: 'string', type: 'string' },
      { name: 'chainId', internalType: 'uint256', type: 'uint256' },
      { name: 'verifyingContract', internalType: 'address', type: 'address' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
      { name: 'extensions', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC721
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc721Abi = [
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
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC721Enumerable
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc721EnumerableAbi = [
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC721Metadata
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc721MetadataAbi = [
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
    inputs: [],
    name: 'name',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', internalType: 'string', type: 'string' }],
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
    inputs: [
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IERC721Receiver
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ierc721ReceiverAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'operator', internalType: 'address', type: 'address' },
      { name: 'from', internalType: 'address', type: 'address' },
      { name: 'tokenId', internalType: 'uint256', type: 'uint256' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'onERC721Received',
    outputs: [{ name: '', internalType: 'bytes4', type: 'bytes4' }],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ILayerZeroEndpointV2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iLayerZeroEndpointV2Abi = [
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'from',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'to', internalType: 'address', type: 'address', indexed: false },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
    ],
    name: 'ComposeDelivered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'from',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'to', internalType: 'address', type: 'address', indexed: false },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
      { name: 'message', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'ComposeSent',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'DefaultReceiveLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'oldLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'expiry',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'DefaultReceiveLibraryTimeoutSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'DefaultSendLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'sender',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'delegate',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'DelegateSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
    ],
    name: 'InboundNonceSkipped',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'LibraryRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'executor',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
      { name: 'gas', internalType: 'uint256', type: 'uint256', indexed: false },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      { name: 'message', internalType: 'bytes', type: 'bytes', indexed: false },
      {
        name: 'extraData',
        internalType: 'bytes',
        type: 'bytes',
        indexed: false,
      },
      { name: 'reason', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'LzComposeAlert',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'executor',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'origin',
        internalType: 'struct Origin',
        type: 'tuple',
        components: [
          { name: 'srcEid', internalType: 'uint32', type: 'uint32' },
          { name: 'sender', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
        ],
        indexed: false,
      },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'gas', internalType: 'uint256', type: 'uint256', indexed: false },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      { name: 'message', internalType: 'bytes', type: 'bytes', indexed: false },
      {
        name: 'extraData',
        internalType: 'bytes',
        type: 'bytes',
        indexed: false,
      },
      { name: 'reason', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'LzReceiveAlert',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'token',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'LzTokenSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
      {
        name: 'payloadHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PacketBurnt',
  },
  {
    type: 'event',
    anonymous: false,
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
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'PacketDelivered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
      {
        name: 'payloadHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PacketNilified',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'encodedPayload',
        internalType: 'bytes',
        type: 'bytes',
        indexed: false,
      },
      { name: 'options', internalType: 'bytes', type: 'bytes', indexed: false },
      {
        name: 'sendLibrary',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'PacketSent',
  },
  {
    type: 'event',
    anonymous: false,
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
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'payloadHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PacketVerified',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'ReceiveLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'oldLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'timeout',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ReceiveLibraryTimeoutSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'sender',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'SendLibrarySet',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
      { name: '_payloadHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'burn',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
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
    ],
    name: 'clear',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_from', internalType: 'address', type: 'address' },
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
    ],
    name: 'composeQueue',
    outputs: [
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultReceiveLibrary',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultReceiveLibraryTimeout',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultSendLibrary',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'eid',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_configType', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getConfig',
    outputs: [{ name: 'config', internalType: 'bytes', type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getReceiveLibrary',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'isDefault', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getRegisteredLibraries',
    outputs: [{ name: '', internalType: 'address[]', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getSendContext',
    outputs: [
      { name: 'dstEid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getSendLibrary',
    outputs: [{ name: 'lib', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'inboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'inboundPayloadHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
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
      { name: '_receiver', internalType: 'address', type: 'address' },
    ],
    name: 'initializable',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'isDefaultSendLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_lib', internalType: 'address', type: 'address' }],
    name: 'isRegisteredLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'isSendingMessage',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'isSupportedEid',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
    ],
    name: 'isValidReceiveLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'lazyInboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_from', internalType: 'address', type: 'address' },
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzCompose',
    outputs: [],
    stateMutability: 'payable',
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
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzReceive',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'lzToken',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nativeToken',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_dstEid', internalType: 'uint32', type: 'uint32' },
      { name: '_receiver', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextGuid',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
      { name: '_payloadHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nilify',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_dstEid', internalType: 'uint32', type: 'uint32' },
      { name: '_receiver', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'outboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_params',
        internalType: 'struct MessagingParams',
        type: 'tuple',
        components: [
          { name: 'dstEid', internalType: 'uint32', type: 'uint32' },
          { name: 'receiver', internalType: 'bytes32', type: 'bytes32' },
          { name: 'message', internalType: 'bytes', type: 'bytes' },
          { name: 'options', internalType: 'bytes', type: 'bytes' },
          { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
        ],
      },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'quote',
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
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'receiveLibraryTimeout',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_lib', internalType: 'address', type: 'address' }],
    name: 'registerLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: '_params',
        internalType: 'struct MessagingParams',
        type: 'tuple',
        components: [
          { name: 'dstEid', internalType: 'uint32', type: 'uint32' },
          { name: 'receiver', internalType: 'bytes32', type: 'bytes32' },
          { name: 'message', internalType: 'bytes', type: 'bytes' },
          { name: 'options', internalType: 'bytes', type: 'bytes' },
          { name: 'payInLzToken', internalType: 'bool', type: 'bool' },
        ],
      },
      { name: '_refundAddress', internalType: 'address', type: 'address' },
    ],
    name: 'send',
    outputs: [
      {
        name: '',
        internalType: 'struct MessagingReceipt',
        type: 'tuple',
        components: [
          { name: 'guid', internalType: 'bytes32', type: 'bytes32' },
          { name: 'nonce', internalType: 'uint64', type: 'uint64' },
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
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'sendCompose',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_lib', internalType: 'address', type: 'address' },
      {
        name: '_params',
        internalType: 'struct SetConfigParam[]',
        type: 'tuple[]',
        components: [
          { name: 'eid', internalType: 'uint32', type: 'uint32' },
          { name: 'configType', internalType: 'uint32', type: 'uint32' },
          { name: 'config', internalType: 'bytes', type: 'bytes' },
        ],
      },
    ],
    name: 'setConfig',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
      { name: '_gracePeriod', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDefaultReceiveLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_expiry', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDefaultReceiveLibraryTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
    ],
    name: 'setDefaultSendLibrary',
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
    inputs: [{ name: '_lzToken', internalType: 'address', type: 'address' }],
    name: 'setLzToken',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
      { name: '_gracePeriod', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setReceiveLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_expiry', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setReceiveLibraryTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
    ],
    name: 'setSendLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'skip',
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
      { name: '_receiver', internalType: 'address', type: 'address' },
    ],
    name: 'verifiable',
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
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_payloadHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'verify',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ILayerZeroReceiver
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iLayerZeroReceiverAbi = [
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
    ],
    name: 'allowInitializePath',
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
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IMessageLibManager
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iMessageLibManagerAbi = [
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'DefaultReceiveLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'oldLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'expiry',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'DefaultReceiveLibraryTimeoutSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'DefaultSendLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'LibraryRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'ReceiveLibrarySet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'oldLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'timeout',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'ReceiveLibraryTimeoutSet',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'sender',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'eid', internalType: 'uint32', type: 'uint32', indexed: false },
      {
        name: 'newLib',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
    ],
    name: 'SendLibrarySet',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultReceiveLibrary',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultReceiveLibraryTimeout',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'defaultSendLibrary',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_configType', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getConfig',
    outputs: [{ name: 'config', internalType: 'bytes', type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getReceiveLibrary',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'isDefault', internalType: 'bool', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'getRegisteredLibraries',
    outputs: [{ name: '', internalType: 'address[]', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'getSendLibrary',
    outputs: [{ name: 'lib', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'isDefaultSendLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_lib', internalType: 'address', type: 'address' }],
    name: 'isRegisteredLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'isSupportedEid',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
    ],
    name: 'isValidReceiveLibrary',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
    ],
    name: 'receiveLibraryTimeout',
    outputs: [
      { name: 'lib', internalType: 'address', type: 'address' },
      { name: 'expiry', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_lib', internalType: 'address', type: 'address' }],
    name: 'registerLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_lib', internalType: 'address', type: 'address' },
      {
        name: '_params',
        internalType: 'struct SetConfigParam[]',
        type: 'tuple[]',
        components: [
          { name: 'eid', internalType: 'uint32', type: 'uint32' },
          { name: 'configType', internalType: 'uint32', type: 'uint32' },
          { name: 'config', internalType: 'bytes', type: 'bytes' },
        ],
      },
    ],
    name: 'setConfig',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
      { name: '_gracePeriod', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDefaultReceiveLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_expiry', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setDefaultReceiveLibraryTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
    ],
    name: 'setDefaultSendLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
      { name: '_gracePeriod', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setReceiveLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_lib', internalType: 'address', type: 'address' },
      { name: '_expiry', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'setReceiveLibraryTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_newLib', internalType: 'address', type: 'address' },
    ],
    name: 'setSendLibrary',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IMessagingChannel
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iMessagingChannelAbi = [
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
    ],
    name: 'InboundNonceSkipped',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
      {
        name: 'payloadHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PacketBurnt',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'srcEid',
        internalType: 'uint32',
        type: 'uint32',
        indexed: false,
      },
      {
        name: 'sender',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      {
        name: 'receiver',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'nonce', internalType: 'uint64', type: 'uint64', indexed: false },
      {
        name: 'payloadHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
    ],
    name: 'PacketNilified',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
      { name: '_payloadHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'burn',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'eid',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'inboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'inboundPayloadHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_receiver', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'lazyInboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_dstEid', internalType: 'uint32', type: 'uint32' },
      { name: '_receiver', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextGuid',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
      { name: '_payloadHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nilify',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_sender', internalType: 'address', type: 'address' },
      { name: '_dstEid', internalType: 'uint32', type: 'uint32' },
      { name: '_receiver', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'outboundNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_oapp', internalType: 'address', type: 'address' },
      { name: '_srcEid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
      { name: '_nonce', internalType: 'uint64', type: 'uint64' },
    ],
    name: 'skip',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IMessagingComposer
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iMessagingComposerAbi = [
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'from',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'to', internalType: 'address', type: 'address', indexed: false },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
    ],
    name: 'ComposeDelivered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'from',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      { name: 'to', internalType: 'address', type: 'address', indexed: false },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
      { name: 'message', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'ComposeSent',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'from', internalType: 'address', type: 'address', indexed: true },
      { name: 'to', internalType: 'address', type: 'address', indexed: true },
      {
        name: 'executor',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'guid',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'index', internalType: 'uint16', type: 'uint16', indexed: false },
      { name: 'gas', internalType: 'uint256', type: 'uint256', indexed: false },
      {
        name: 'value',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      { name: 'message', internalType: 'bytes', type: 'bytes', indexed: false },
      {
        name: 'extraData',
        internalType: 'bytes',
        type: 'bytes',
        indexed: false,
      },
      { name: 'reason', internalType: 'bytes', type: 'bytes', indexed: false },
    ],
    name: 'LzComposeAlert',
  },
  {
    type: 'function',
    inputs: [
      { name: '_from', internalType: 'address', type: 'address' },
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
    ],
    name: 'composeQueue',
    outputs: [
      { name: 'messageHash', internalType: 'bytes32', type: 'bytes32' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: '_from', internalType: 'address', type: 'address' },
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_extraData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'lzCompose',
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: '_to', internalType: 'address', type: 'address' },
      { name: '_guid', internalType: 'bytes32', type: 'bytes32' },
      { name: '_index', internalType: 'uint16', type: 'uint16' },
      { name: '_message', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'sendCompose',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IMessagingContext
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iMessagingContextAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'getSendContext',
    outputs: [
      { name: 'dstEid', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'isSendingMessage',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IMint
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iMintAbi = [
  {
    type: 'function',
    inputs: [
      { name: 'clientId', internalType: 'uint32', type: 'uint32' },
      { name: 'sender', internalType: 'address', type: 'address' },
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
    name: 'nextId',
    outputs: [{ name: '', internalType: 'uint32', type: 'uint32' }],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IOAppCore
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ioAppCoreAbi = [
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
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
    inputs: [],
    name: 'endpoint',
    outputs: [
      {
        name: 'iEndpoint',
        internalType: 'contract ILayerZeroEndpointV2',
        type: 'address',
      },
    ],
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
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '_eid', internalType: 'uint32', type: 'uint32' }],
    name: 'peers',
    outputs: [{ name: 'peer', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IOAppReceiver
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ioAppReceiverAbi = [
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
    ],
    name: 'allowInitializePath',
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
      { name: '_message', internalType: 'bytes', type: 'bytes' },
      { name: '_sender', internalType: 'address', type: 'address' },
    ],
    name: 'isComposeMsgSender',
    outputs: [{ name: 'isSender', internalType: 'bool', type: 'bool' }],
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
      { name: '_eid', internalType: 'uint32', type: 'uint32' },
      { name: '_sender', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'nextNonce',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
    stateMutability: 'view',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ISpend
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iSpendAbi = [
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
    inputs: [{ name: 'tokenId', internalType: 'uint256', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
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
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ISwapRouter
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const iSwapRouterAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'WETH',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', internalType: 'address', type: 'address' },
      { name: 'tokenB', internalType: 'address', type: 'address' },
      { name: 'amountADesired', internalType: 'uint256', type: 'uint256' },
      { name: 'amountBDesired', internalType: 'uint256', type: 'uint256' },
      { name: 'amountAMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountBMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'addLiquidity',
    outputs: [
      { name: 'amountA', internalType: 'uint256', type: 'uint256' },
      { name: 'amountB', internalType: 'uint256', type: 'uint256' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'amountTokenDesired', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'addLiquidityAVAX',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'amountTokenDesired', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'addLiquidityETH',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'factory',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveIn', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveOut', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'getAmountIn',
    outputs: [{ name: 'amountIn', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveIn', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveOut', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'getAmountOut',
    outputs: [{ name: 'amountOut', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
    ],
    name: 'getAmountsIn',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
    ],
    name: 'getAmountsOut',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountA', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveA', internalType: 'uint256', type: 'uint256' },
      { name: 'reserveB', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'quote',
    outputs: [{ name: 'amountB', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', internalType: 'address', type: 'address' },
      { name: 'tokenB', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountAMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountBMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'removeLiquidity',
    outputs: [
      { name: 'amountA', internalType: 'uint256', type: 'uint256' },
      { name: 'amountB', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'removeLiquidityAVAX',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
      { name: 'approveMax', internalType: 'bool', type: 'bool' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'removeLiquidityAVAXWithPermit',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'removeLiquidityETH',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'token', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountTokenMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETHMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
      { name: 'approveMax', internalType: 'bool', type: 'bool' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'removeLiquidityETHWithPermit',
    outputs: [
      { name: 'amountToken', internalType: 'uint256', type: 'uint256' },
      { name: 'amountETH', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'tokenA', internalType: 'address', type: 'address' },
      { name: 'tokenB', internalType: 'address', type: 'address' },
      { name: 'liquidity', internalType: 'uint256', type: 'uint256' },
      { name: 'amountAMin', internalType: 'uint256', type: 'uint256' },
      { name: 'amountBMin', internalType: 'uint256', type: 'uint256' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
      { name: 'approveMax', internalType: 'bool', type: 'bool' },
      { name: 'v', internalType: 'uint8', type: 'uint8' },
      { name: 'r', internalType: 'bytes32', type: 'bytes32' },
      { name: 's', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'removeLiquidityWithPermit',
    outputs: [
      { name: 'amountA', internalType: 'uint256', type: 'uint256' },
      { name: 'amountB', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapAVAXForExactTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapETHForExactTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOutMin', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapExactAVAXForTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOutMin', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapExactETHForTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', internalType: 'uint256', type: 'uint256' },
      { name: 'amountOutMin', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapExactTokensForAVAX',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', internalType: 'uint256', type: 'uint256' },
      { name: 'amountOutMin', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapExactTokensForETH',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountIn', internalType: 'uint256', type: 'uint256' },
      { name: 'amountOutMin', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapExactTokensForTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'amountInMax', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapTokensForExactAVAX',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'amountInMax', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapTokensForExactETH',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'amountOut', internalType: 'uint256', type: 'uint256' },
      { name: 'amountInMax', internalType: 'uint256', type: 'uint256' },
      { name: 'path', internalType: 'address[]', type: 'address[]' },
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'deadline', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'swapTokensForExactTokens',
    outputs: [
      { name: 'amounts', internalType: 'uint256[]', type: 'uint256[]' },
    ],
    stateMutability: 'nonpayable',
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

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// OApp
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const oAppAbi = [
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
// OAppCore
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const oAppCoreAbi = [
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
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
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
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
// OAppReceiver
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const oAppReceiverAbi = [
  { type: 'error', inputs: [], name: 'InvalidDelegate' },
  { type: 'error', inputs: [], name: 'InvalidEndpointCall' },
  {
    type: 'error',
    inputs: [{ name: 'eid', internalType: 'uint32', type: 'uint32' }],
    name: 'NoPeer',
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
// OAppSender
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const oAppSenderAbi = [
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
    name: 'oAppVersion',
    outputs: [
      { name: 'senderVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'receiverVersion', internalType: 'uint64', type: 'uint64' },
    ],
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
// OptionsBuilder
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const optionsBuilderAbi = [
  {
    type: 'error',
    inputs: [{ name: 'optionType', internalType: 'uint16', type: 'uint16' }],
    name: 'InvalidOptionType',
  },
  {
    type: 'error',
    inputs: [
      { name: 'max', internalType: 'uint256', type: 'uint256' },
      { name: 'actual', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'InvalidSize',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Ownable
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const ownableAbi = [
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
    inputs: [{ name: 'newOwner', internalType: 'address', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ShortStrings
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const shortStringsAbi = [
  { type: 'error', inputs: [], name: 'InvalidShortString' },
  {
    type: 'error',
    inputs: [{ name: 'str', internalType: 'string', type: 'string' }],
    name: 'StringTooLong',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Test
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const testAbi = [
  {
    type: 'function',
    inputs: [],
    name: 'test',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

