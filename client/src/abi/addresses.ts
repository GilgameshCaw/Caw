export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as const;
// Mainnet: USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, USDT 0xdAC17F958D2ee523a2206206994597C13D831ec7
export const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;

// Testnet addresses (Sepolia / Base Sepolia / Arbitrum Sepolia)
export const CAW_ADDRESS = "0x56817dc696448135203C0556f702c6a953260411" as const;
export const CAW_NAMES_ADDRESS = '0x14FFACEB52025d2A04f3FA997e3946b17eB28aF2' as const;
export const CAW_NAME_QUOTER_ADDRESS = '0x92A2d161c13539eD7646e0BE5D464495DddfeD17' as const;
export const CAW_NAMES_MINTER_ADDRESS = '0xbacef3De5A2c8036268df5a59c3cce2fbd533883' as const;
export const URI_GENERATOR_ADDRESS = '0xfD3dC7f5337e5f5b3D532305c915B072fb75bc21' as const;
export const CLIENT_MANAGER_ADDRESS = '0x4524922C4614DBbb79FCcdce6d2c41CaF563FE04' as const;
export const CAW_NAMES_L2_ADDRESS = "0xB379a474C770CB5e7657C8EcC0FF2f7D2863b5bb" as const;
export const CAW_NAMES_L2_MAINNET_ADDRESS = '0xfB9D00d70C747995f2c9D3b31B998bC0C218A399' as const;
export const CAW_ACTIONS_MAINNET_ADDRESS = '0xaEE8a40EEDe3c17dA85339F97472c32618AEa905' as const;
export const CAW_ACTIONS_ADDRESS = "0x701Cae1460569acc64d69B0B757AE847E1565B94" as const;
// Optimistic replication: stake-based archive + L2 challenge relay. The
// archive lives on the replication chain (today: Arbitrum Sepolia);
// CHALLENGE_RELAY lives on the storage chain (Base Sepolia) and forwards
// challenges via LayerZero to the archive's _lzReceive.
export const CAW_ACTIONS_ARCHIVE_ADDRESS = '0x78569305b07972350fF55e1aa5d399ADC9dCdDA3' as const;
export const CAW_CHALLENGE_RELAY_ADDRESS = '0xBE2329e895e0c8e2934c8b3096445c9a11C99d49' as const;
export const CAW_NAME_MARKETPLACE_ADDRESS = '0x5696675aB8e8E82cBe46C805F47875CF836bFd2A' as const; // Updated after deployment
