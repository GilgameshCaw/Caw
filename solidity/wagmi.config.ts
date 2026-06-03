import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

export default defineConfig({
  out: "../client/src/abi/generated.ts",
  contracts: [],
  plugins: [
    foundry({
      project: "./",
      // Only include our contracts, exclude LayerZero deps, test/mock contracts
      include: [
        "CawActions.sol/*.json",
        "CawActionsArchive.sol/*.json",
        "CawChallengeRelay.sol/*.json",
        "CawNetworkManager.sol/*.json",
        "CawProfile.sol/*.json",
        "CawProfileLedger.sol/*.json",
        "CawProfileMinter.sol/*.json",
        "CawProfileQuoter.sol/*.json",
        "CawProfileLens.sol/*.json",
        "CawProfileURI.sol/*.json",
        "CawProfileMarketplace.sol/*.json",
        "CivicKycVerifier.sol/*.json",
        "MintableCaw.sol/*.json",
        "SmartEOA.sol/*.json",
      ],
      forge: {
        build: false, // artifacts already built; don't re-run forge build
      },
    }),
  ],
});
