# storage-chain erc1271 selection

ahdmesh identified that the CLI selected L1.CawActionsERC1271 while receipt verification selected the network storage chain. the deployment writer already selects the storage chain. RawEventsGatherer and ValidatorService consume the shared constant for storage-chain reads/submission; the pinned frontend has no direct named reference to that constant. SmartEOA remains selected from L1.

the CLI now emits selected-chain CawActionsERC1271 and carries that verified address through resolveHistoryFloor. the final metadata read rejects changed, added or removed siblings before publishing configuration. an absent storage sibling remains undefined; no L1 fallback.

127 local installer checks pass. the previous generator fails 12 new checks covering distinct L1/storage addresses, storage-only changes, sibling drift and absence on both L2 selections. syntax validation passes. these fixtures execute actual generator code with external dependencies mocked.

combined marker check: set CAW_HISTORY_PARENT_SOURCE to the absolute path of client/src/services/RawEventsGatherer/index.ts from PR329 at b57ce8e470778ef2034558a5ea770abe79dd54ac, then run node --test solidity/test-deploy/installer-history.test.cjs from the repository root. the combined check uses generated sibling constants in the actual service marker code; unchanged scope resumes, changed sibling does not reuse completion, on both L2 selections. the optional combined check is explicitly skipped without that source. all three installer suites with this setting passed 128 checks locally.

this is not a full production installation, semantic TypeScript check, live RPC event-loss reproduction or proof of history completeness. scanner transport/database dependencies remain mocked. existing installs must regenerate addresses/configuration with verified receipts before restart; updating code alone does not rewrite generated files. do not delete prior rows or markers automatically. review retained data and perform the required backfill separately.
