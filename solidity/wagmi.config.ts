import { defineConfig } from "@wagmi/cli";
import { hardhat } from "@wagmi/cli/plugins";

export default defineConfig({
  out: "../client/src/abi/generated.ts",
  contracts: [],
  plugins: [
    hardhat({
      project: "./",
      // Only include our contracts, exclude LayerZero dependencies
      include: [
        "contracts/CawActions.sol/**",
        "contracts/CawActionsArchive.sol/**",
        "contracts/CawChallengeRelay.sol/**",
        "contracts/CawClientManager.sol/**",
        "contracts/CawProfile.sol/**",
        "contracts/CawProfileL2.sol/**",
        "contracts/CawProfileMinter.sol/**",
        "contracts/CawProfileQuoter.sol/**",
        "contracts/CawProfileURI.sol/**",
        "contracts/CawProfileMarketplace.sol/**",
        "contracts/MintableCaw.sol/**",
      ],
    }),
  ],
});

