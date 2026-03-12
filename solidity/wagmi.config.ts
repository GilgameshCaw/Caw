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
        "contracts/CawActionsReplicator.sol/**",
        "contracts/CawClientManager.sol/**",
        "contracts/CawName.sol/**",
        "contracts/CawNameL2.sol/**",
        "contracts/CawNameMinter.sol/**",
        "contracts/CawNameQuoter.sol/**",
        "contracts/CawNameURI.sol/**",
        "contracts/MintableCaw.sol/**",
      ],
    }),
  ],
});

