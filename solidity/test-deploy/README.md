# Sealed deployment wiring checks

From the repository root, using Node 24:

```sh
node --test --test-isolation=none --test-concurrency=1 --test-timeout=10000 solidity/test-deploy/sealed-wiring.test.cjs
node --check solidity/scripts/deploy.js
```

No dependency installation, wallet, RPC endpoint or chain is required.

The tests load the real `deploy.js` definitions in a restricted VM and remove only its exact final `main()` invocation. A changed entrypoint fails the loader rather than starting deployment. Contract calls and reads use deterministic doubles; filesystem writes, subprocesses, providers and unexpected imports are unavailable to the deployment code. The phase scheduler and required linking steps execute their actual implementation.

The suite checks:

- Required Phase 2 one-shot profile/minter setters and every directed Phase 5 archive/relay link.
- Missing addresses or contract handles, failed reads, rejected setters, and successful receipts that do not establish the expected state.
- Exact one-shot resume targets; a different non-zero address is not completion.
- Both minter references and both directions of every archive/relay path before sealing, including a resumed deployment.
- The all-chain barrier: no finalizer starts while another chain's required read-back is pending or has failed.
- Correct wiring, optional broadcast/approval failure handling, and the unchanged unsealed development lifecycle.

The added checks apply when sealing is requested. They establish agreement between returned contract state and this deployment's expected addresses. They do not authenticate an RPC server, validate deployed bytecode, provide cross-chain atomicity, or prove that all remaining protocol requirements are satisfied. A later finalizer can still fail after another chain has sealed; recovery must preserve the existing monotonic sealing policy.

These are deployment-runner regressions, not Solidity/EVM tests or a full multi-chain deployment. Existing finalization proof validation remains separate in `scripts/verify-deploy-wiring.js`. LayerZero library configuration, KYC policy/registration, Network economics, and permissionless future expansion need their own review and integration checks.
# constructor-binding regression

the suite also exercises L1 and every configured L2 ledger's cawActions,
capOracle and erc1271Sibling bindings, plus each cap oracle's cawActions.
missing addresses/handles, failed reads and mismatches must stop the sealed
Phase 7 before any finalizer. earlier nonce assertions are required when
sealing; the final barrier re-reads constructor bindings on resume.
unsealed development remains a separate path. these are mocked runner tests,
not live-chain deployment evidence.

