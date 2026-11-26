# Fresh-browser peer discovery with the CAW API offline

Runtime under review is `25d95db8830e6c808378c17700926f981e62e831`. The reproduction commit adds files under this directory only. The PR comment pins that commit for independent runs. The source manifest covers the production store, history reader, ABI and contract.

## Run on Linux x86-64

Author environment: Ubuntu 22.04.5, Node 20.20.2, npm 10.8.2, Anvil 1.5.1 (b0a9dd9), headless Chromium 145.0.7632.6. Install Foundry v1.5.1 and put its anvil executable on PATH. From the pinned checkout:

```sh
cd docs/community/pr506-browser
sha256sum -c packet.sha256
npm ci
npx --no-install playwright install --with-deps chromium
bash run.sh > my-result.json
diff -u result.json my-result.json
```

The browser installer may require system package installation privileges. The run starts its own loopback chain on a free port and stops it afterwards. No wallet setup or public RPC is needed. The runner exits nonzero if any assertion fails. Preserve stderr and the exit status on failure.

## What the browser checks

A new Chromium context opens a small static page with empty storage. The page loads the production peer store. Wagmi can write its settings at startup. The runner checks that the store begins with zero peers and no peer cache. On this first visit the page origin is the only known CAW API. Its discovery request gets a closed connection. The runner records the failed request and blocks external origins.

The store then uses the local Ethereum RPC. The real registry contains two peers. One changed its URL and validator before deactivation. The runner checks both full records, the saved cache, the chain source indicator and the single active URL available for routing. The active flag means registered as active. This test does not establish endpoint reachability.

The page uses the real store, reader, ABI and a freshly compiled registry. It supplies a local wagmi configuration, the test deployment address and an empty API host. It exercises the browser discovery path; full application startup, public RPC behavior and independent reproduction are separate checks.
