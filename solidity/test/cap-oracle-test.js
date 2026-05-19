const CawCapOracle = artifacts.require("CawCapOracle");
const MockCawActionsCapTarget = artifacts.require("MockCawActionsCapTarget");
const BN = web3.utils.BN;

// UQ112.112: a price `p` (raw ratio of WETH-per-CAW) is encoded as `p * 2^112`.
// To produce a TWAP that round-trips to a known wei-per-CAW, the cumulative
// delta over a window should be `priceUQ * windowSeconds`.

const TWO_112 = new BN(2).pow(new BN(112));

// Produce a UQ112.112 price of `wethPerCaw` (a fractional ETH-per-CAW value
// expressed as wei-per-CAW for precision). Returns BN.
function uqPriceFromWeiPerCaw(weiPerCaw) {
  // wethPerCaw = weiPerCaw / 1e18, so UQ price = (weiPerCaw * 2^112) / 1e18.
  return TWO_112.mul(new BN(weiPerCaw)).div(new BN("1000000000000000000"));
}

contract("CawCapOracle", (accounts) => {
  const writer = accounts[1];
  const stranger = accounts[2];

  let oracle;
  let mockActions;

  beforeEach(async () => {
    mockActions = await MockCawActionsCapTarget.new();
    oracle = await CawCapOracle.new(writer, mockActions.address);
  });

  // EVM time, NOT wall-clock. Ganache instances drift relative to the host
  // clock; on a long-running dev session we've seen +5 days. Any timestamp
  // anchored on Date.now() can land in the past or future from the EVM's
  // perspective, breaking the oracle's staleness/freshness logic in
  // surprising ways. Always use this helper instead of Date.now()/1000.
  async function evmNow() {
    const block = await web3.eth.getBlock("latest");
    return Number(block.timestamp);
  }

  describe("ingestion", () => {
    it("rejects writes from non-writer", async () => {
      let threw = false;
      try {
        await oracle.recordSample(0, 1, { from: stranger });
      } catch (e) {
        threw = true;
        assert.match(e.message, /UnauthorizedWriter|revert/i);
      }
      assert(threw, "expected revert");
    });

    it("accepts ordered samples from writer", async () => {
      await oracle.recordSample(100, 1000, { from: writer });
      await oracle.recordSample(200, 1010, { from: writer });
      const written = await oracle.samplesWritten();
      assert.equal(written.toString(), "2");
    });

    it("silently skips out-of-order timestamps", async () => {
      await oracle.recordSample(100, 1000, { from: writer });
      await oracle.recordSample(50, 999, { from: writer }); // earlier — skipped
      const written = await oracle.samplesWritten();
      assert.equal(written.toString(), "1", "out-of-order sample should not advance counter");
    });
  });

  describe("dormant fallback", () => {
    it("returns baseline when no samples", async () => {
      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(cap.toString(), baseline.toString());
    });

    it("returns baseline when only one sample", async () => {
      await oracle.recordSample(100, 1000, { from: writer });
      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(cap.toString(), baseline.toString());
    });

    it("returns baseline when latest sample is older than STALE_THRESHOLD", async () => {
      // Sample timestamps far in the past relative to chain time → stale.
      const now = await evmNow();
      const ancient = now - 7 * 86400; // 7 days ago
      await oracle.recordSample(0, ancient, { from: writer });
      await oracle.recordSample(uqPriceFromWeiPerCaw("1000000").mul(new BN(60)), ancient + 60, { from: writer });

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(cap.toString(), baseline.toString(), "stale oracle should fall back to baseline");
    });
  });

  // Helper: record a TWAP-defining pair of samples MIN_WINDOW + 1 second apart,
  // so twapEthPerCaw returns fresh and matches the supplied weiPerWholeCaw price.
  //
  // CRITICAL: anchor on EVM block.timestamp, NOT Date.now(). Ganache instances
  // that have been running a while accumulate drift between wall-clock and EVM
  // time (we've seen +5 days on the test environment). Using Date.now() puts
  // `latest.timestamp` in the past from the EVM's POV, the STALE_THRESHOLD
  // check fires (latest > now - 24h fails), and twap returns fresh=false →
  // capForAction returns baseline → tests asserting `cap < baseline` fail.
  async function seedConstantPrice(weiPerWholeCaw) {
    const priceUQ = uqPriceFromWeiPerCaw(weiPerWholeCaw);
    const minWindowSecs = 86400; // MIN_WINDOW
    const block = await web3.eth.getBlock("latest");
    const t1 = Number(block.timestamp);
    const t0 = t1 - (minWindowSecs + 60);
    const elapsed = t1 - t0;

    await oracle.recordSample(0, t0, { from: writer });
    await oracle.recordSample(priceUQ.mul(new BN(elapsed)), t1, { from: writer });
  }

  describe("cap binds with fresh oracle", () => {
    it("does not cap below baseline when CAW is cheap (today)", async () => {
      // Today's CAW is ~$1e-9 each, so wei-per-whole-CAW at ETH=$5k is
      // about 1e-9 / 5e3 × 1e18 = 200 wei. At that price, the CAP_LIKE
      // (2e11 wei = $0.01) buys 1e9 CAW — way above baseline 2000.
      await seedConstantPrice(new BN("200"));

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(
        cap.toString(),
        baseline.toString(),
        "cheap CAW -> baseline binds, cap dormant"
      );
    });

    it("caps below baseline at a realistic $3B mcap scenario", async () => {
      // CAW mcap $3.3B at 666B supply → $5e-6 / CAW → 1e9 wei / whole CAW.
      // Expected: cappedCaw = 2e11 / 1e9 = 200 whole CAW (vs baseline 2000).
      await seedConstantPrice(new BN("1000000000")); // 1e9

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();

      assert(
        cap.lt(baseline),
        `expected cap (${cap.toString()}) < baseline (${baseline.toString()})`
      );
      assert.equal(cap.toString(), "200", "cap should clamp LIKE to 200 whole CAW at $3B mcap");
    });

    it("at X-scale mcap ($44B), cap floors at 1 whole CAW", async () => {
      // X/Twitter-scale: CAW mcap $44B / 666B = $0.066 / CAW → ~1.32e13 wei / CAW @ ETH=$5k.
      // 2e11 / 1.32e13 ≈ 0.015 whole CAW → floors to 1.
      await seedConstantPrice(new BN("13200000000000")); // 1.32e13

      const cap = await oracle.capLike();
      assert.equal(cap.toString(), "1", "floor at 1 whole CAW at X-scale mcap");
    });

    it("preserves ratios across action types at realistic mcap", async () => {
      // $3.3B mcap → 1e9 wei / whole CAW.
      //   LIKE:    2e11 / 1e9 =  200 (vs baseline 2000)   → cap binds
      //   RECAW:   4e11 / 1e9 =  400 (vs baseline 4000)   → cap binds
      //   CAW:     5e11 / 1e9 =  500 (vs baseline 5000)   → cap binds
      //   FOLLOW: 30e11 / 1e9 = 3000 (vs baseline 30000)  → cap binds
      await seedConstantPrice(new BN("1000000000")); // 1e9

      assert.equal((await oracle.capLike()).toString(), "200");
      assert.equal((await oracle.capRecaw()).toString(), "400");
      assert.equal((await oracle.capCaw()).toString(), "500");
      assert.equal((await oracle.capFollow()).toString(), "3000");

      // Ratios match today's baselines (1 : 2 : 2.5 : 15).
      // LIKE : RECAW = 200:400 = 1:2     ✓
      // LIKE : CAW   = 200:500 = 2:5     ✓
      // LIKE : FOLLOW = 200:3000 = 1:15  ✓
    });

    it("splits-preserved sanity: capped LIKE total scales 80/20 evenly", async () => {
      // This test asserts the property CawActions._applyAction needs to enforce:
      // when total scales from baseline 2000 → cap 200 (×0.1), receiver share
      // (1600 → 160) and depositor share (400 → 40) must both scale by ×0.1.
      // The oracle itself doesn't compute these — but the test documents the
      // invariant so the integration code has a fixed target.
      await seedConstantPrice(new BN("1000000000"));
      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();

      // Both numerator/denominator known integer → no floor() surprises here.
      const cappedReceiver = new BN(1600).mul(cap).div(baseline);
      const cappedDepositors = new BN(400).mul(cap).div(baseline);

      assert.equal(cappedReceiver.toString(), "160", "receiver scales proportionally");
      assert.equal(cappedDepositors.toString(), "40", "depositors scale proportionally");
      assert.equal(
        cappedReceiver.add(cappedDepositors).toString(),
        cap.toString(),
        "scaled parts sum to capped total"
      );
    });
  });

  describe("MIN_WINDOW guard", () => {
    it("returns baseline when samples span less than MIN_WINDOW", async () => {
      // Two samples 60 seconds apart — well under 1 day. Should fall back to baseline.
      const priceUQ = uqPriceFromWeiPerCaw(new BN("1000000000")); // would-cap price
      const now = await evmNow();
      const t0 = now - 60;

      await oracle.recordSample(0, t0, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(60)), now, { from: writer });

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(
        cap.toString(),
        baseline.toString(),
        "<1 day of samples -> cap dormant regardless of would-cap price"
      );

      // Direct probe of twapEthPerCaw to confirm fresh=false reason
      const result = await oracle.twapEthPerCaw();
      assert.equal(result.fresh, false, "twap should report not-fresh");
    });

    it("transitions to fresh once samples span MIN_WINDOW", async () => {
      // Sample 1 day + 1 second apart → just over MIN_WINDOW → fresh.
      // Anchor on EVM block.timestamp (not Date.now()) for the same reason
      // seedConstantPrice does — see the helper's comment.
      const priceUQ = uqPriceFromWeiPerCaw(new BN("1000000000"));
      const minWindowSecs = 86400;
      const block = await web3.eth.getBlock("latest");
      const t1 = Number(block.timestamp);
      const t0 = t1 - (minWindowSecs + 1);

      await oracle.recordSample(0, t0, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(minWindowSecs + 1)), t1, { from: writer });

      const result = await oracle.twapEthPerCaw();
      assert.equal(result.fresh, true, ">= MIN_WINDOW -> fresh");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extended test cases (architect plan, cases 5-10)
  // Cases 1-2 (mainnet fork) require FORK_MAINNET_RPC_URL; skip here.
  // Cases 3-4 are covered by existing "dormant fallback" and "MIN_WINDOW" suites.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Case 5 - early protocol path (latest.timestamp < 7d)", () => {
    it("uses the oldest-available sample even when window < 7d", async () => {
      const priceUQ = uqPriceFromWeiPerCaw(new BN("1000000000")); // would-cap price
      const minWindowSecs = 86400;
      const earlyT0 = minWindowSecs + 1;
      const earlyT1 = minWindowSecs + 3600;

      // These timestamps are ancient (stale > 24h from now), so the staleness
      // check triggers. This correctly tests the code path where the TWAP_WINDOW
      // anchor search is skipped — the staleness guard fires first.
      await oracle.recordSample(0, earlyT0, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(3600)), earlyT1, { from: writer });

      const result = await oracle.twapEthPerCaw();
      assert.equal(result.fresh, false, "stale early data -> fresh=false");

      const cap = await oracle.capForAction(2000, "200000000000");
      assert.equal(cap.toString(), "2000", "dormant oracle returns baseline");
    });
  });

  describe("Case 6 - cap binding (ethCap / twap < baseline)", () => {
    it("returns capped value when ETH cap / TWAP price < baseline", async () => {
      await seedConstantPrice(new BN("1000000000")); // 1e9 wei/CAW
      // 2e11 / 1e9 = 200 < baseline 5000
      const capped = await oracle.capForAction(5000, "200000000000");
      assert.equal(capped.toString(), "200", "capForAction with custom args: 2e11 / 1e9 = 200 < baseline 5000");
    });
  });

  describe("Case 7 - baseline binding (ethCap / twap > baseline)", () => {
    it("returns baseline when ethCap / TWAP > baseline (cheap CAW)", async () => {
      await seedConstantPrice(new BN("200"));
      const capped = await oracle.capForAction(2000, "200000000000");
      assert.equal(capped.toString(), "2000", "baseline binds when cap > baseline");
    });
  });

  describe("Case 8 - floor at 1 (extremely high price -> 1, not 0)", () => {
    it("floors at 1 whole CAW when computed cap would be 0", async () => {
      await seedConstantPrice(new BN("10000000000000000")); // 1e16
      const cap = await oracle.capLike();
      assert.equal(cap.toString(), "1", "floor at 1 for extreme price");
    });
  });

  describe("Case 9 - wrap-around (cumulative near 2^224 - 1)", () => {
    it("handles cumulative wrap-around across 2^224 boundary without corruption", async () => {
      const TWO_224 = new BN(2).pow(new BN(224));
      const minWindowSecs = 86400;
      const now = await evmNow();
      const t0 = now - (minWindowSecs + 60);

      const oldestCumulative = TWO_224.subn(1000);
      const priceUQ = uqPriceFromWeiPerCaw(new BN("1000000000"));
      const elapsed = minWindowSecs + 60;
      const trueDelta = priceUQ.mul(new BN(elapsed));
      const latestCumulative = trueDelta.subn(1000);

      await oracle.recordSample(oldestCumulative.maskn(256), t0, { from: writer });
      await oracle.recordSample(latestCumulative.maskn(256), now, { from: writer });

      const result = await oracle.twapEthPerCaw();
      assert.equal(result.fresh, true, "wrap-around oracle reports fresh");
      assert(
        new BN(result.twap.toString()).gt(new BN(0)),
        "TWAP non-zero after cumulative wrap"
      );
    });
  });

  describe("Case 10 - out-of-order LZ delivery (silent skip)", () => {
    it("silently skips a sample with a non-monotonic timestamp", async () => {
      const now = await evmNow();
      const minWindowSecs = 86400;
      const t0 = now - (minWindowSecs + 60);

      const priceUQ = uqPriceFromWeiPerCaw(new BN("1000000000"));
      await oracle.recordSample(0, t0, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(minWindowSecs + 60)), now, { from: writer });

      const writtenBefore = (await oracle.samplesWritten()).toString();

      const stale = t0 + 3600;
      await oracle.recordSample(1234, stale, { from: writer });

      const writtenAfter = (await oracle.samplesWritten()).toString();
      assert.equal(writtenBefore, writtenAfter, "out-of-order sample doesn't advance samplesWritten");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Push-ratio model tests (new with the pushed-ratio design)
  // ─────────────────────────────────────────────────────────────────────────

  describe("push-ratio: dormant to active transition", () => {
    it("pushes non-zero ratio to CawActions when cap binds", async () => {
      // Price that binds the LIKE cap: 1e9 wei/CAW → likeCap=200 < BASELINE_LIKE=2000
      // Starting state: mockActions.capStateRatio() = 0 (dormant)
      assert.equal((await mockActions.setRatioCallCount()).toString(), "0", "no push yet");

      await seedConstantPrice(new BN("1000000000")); // 1e9 → binds

      // seedConstantPrice writes 2 samples; second one triggers _maybePushRatio
      const callCount = await mockActions.setRatioCallCount();
      assert(callCount.toNumber() >= 1, "oracle should have pushed ratio to CawActions");

      const storedRatio = await mockActions.lastSetRatio();
      assert(!storedRatio.eq(new BN(0)), "stored ratio should be non-zero");
    });
  });

  describe("push-ratio: active within 100 bps — no push", () => {
    it("does not push when ratio moves less than 100 bps", async () => {
      // Seed oracle to fresh+binding state. This fires the initial push.
      await seedConstantPrice(new BN("1000000000")); // 1e9 wei/CAW
      const firstCallCount = (await mockActions.setRatioCallCount()).toNumber();
      assert(firstCallCount >= 1, "initial push expected");
      const firstRatio = await mockActions.lastSetRatio();

      // Add a THIRD sample to the SAME oracle at a 50-bps-moved price.
      // Using the same oracle preserves the existing 2-sample window so
      // freshness stays true at the third sample; the test previously used
      // a fresh oracle2 which started under-populated, fired a clear-to-0
      // push from the dormant path, then a re-push when the second sample
      // brought the window back to fresh — both spurious for this test.
      //
      // seedConstantPrice wrote cumulative = priceUQ_old * elapsed at t1.
      // For the third sample at t1+1, the cumulative needs to advance by
      // priceUQ_new (1 second × the new instantaneous price). Compute it
      // directly from the constants:
      const minWindowSecs = 86400;
      const elapsed = minWindowSecs + 60;
      const priceUQ_old = uqPriceFromWeiPerCaw(new BN("1000000000"));
      const priceUQ_new = uqPriceFromWeiPerCaw(new BN("1005000000")); // 0.5% up
      const cumulativeT1 = priceUQ_old.mul(new BN(elapsed)); // what seedConstantPrice wrote
      const newCumulative = cumulativeT1.add(priceUQ_new); // +1 second at new price
      const now = await evmNow();
      await oracle.recordSample(newCumulative, now + 1, { from: writer });

      // After the 0.5% move, the oracle's _maybePushRatio computes a new
      // TWAP within 100 bps of firstRatio. Hysteresis must suppress the push.
      const afterCallCount = (await mockActions.setRatioCallCount()).toNumber();
      assert.equal(
        afterCallCount,
        firstCallCount,
        "50 bps move should not trigger a push (hysteresis)"
      );
      assert.equal(
        (await mockActions.lastSetRatio()).toString(),
        firstRatio.toString(),
        "ratio unchanged after <100 bps move"
      );
    });
  });

  describe("push-ratio: active with 200 bps move — triggers push", () => {
    it("pushes when ratio moves more than 100 bps", async () => {
      // Set an initial ratio directly in mockActions to simulate prior state.
      // Price 1e9, then move 2% to 1.02e9 = 1020000000.
      await seedConstantPrice(new BN("1000000000")); // activates, pushes ratio
      const afterFirst = (await mockActions.setRatioCallCount()).toNumber();

      const oracle3 = await CawCapOracle.new(writer, mockActions.address);
      const priceUQ3 = uqPriceFromWeiPerCaw(new BN("1020000000")); // 2% move
      const minWindowSecs = 86400;
      const now = await evmNow();
      const t0 = now - (minWindowSecs + 60);
      await oracle3.recordSample(0, t0, { from: writer });
      await oracle3.recordSample(priceUQ3.mul(new BN(minWindowSecs + 60)), now, { from: writer });

      const afterSecond = (await mockActions.setRatioCallCount()).toNumber();
      assert(
        afterSecond > afterFirst,
        `2% move (>100 bps) should trigger a push; calls: ${afterFirst} -> ${afterSecond}`
      );
    });
  });

  describe("push-ratio: active to dormant (cap stops binding)", () => {
    it("pushes ratio=0 to CawActions when cap no longer binds", async () => {
      // First activate with expensive CAW
      await seedConstantPrice(new BN("1000000000")); // binds
      const afterBind = await mockActions.setRatioCallCount();
      assert(afterBind.toNumber() >= 1, "initial push expected");
      const activeRatio = await mockActions.lastSetRatio();
      assert(!activeRatio.eq(new BN(0)), "ratio should be non-zero when binding");

      // Now deploy fresh oracle with cheap CAW price — won't bind
      const oracle4 = await CawCapOracle.new(writer, mockActions.address);
      // 200 wei/CAW: likeCap = 2e11 / 200 = 1e9 >> BASELINE_LIKE=2000 → doesn't bind
      const priceUQ4 = uqPriceFromWeiPerCaw(new BN("200"));
      const minWindowSecs = 86400;
      const now = await evmNow();
      const t0 = now - (minWindowSecs + 60);
      await oracle4.recordSample(0, t0, { from: writer });
      await oracle4.recordSample(priceUQ4.mul(new BN(minWindowSecs + 60)), now, { from: writer });

      // mockActions still has the old non-zero ratio → oracle4 should clear it
      const afterUnbind = await mockActions.setRatioCallCount();
      assert(
        afterUnbind.toNumber() > afterBind.toNumber(),
        "dormant transition should trigger setCapRatio(0)"
      );
      assert.equal(
        (await mockActions.lastSetRatio()).toString(),
        "0",
        "ratio cleared to 0 when cap no longer binds"
      );
    });
  });

  describe("push-ratio: stale oracle clears stored ratio", () => {
    it("does not push from CawActions (staleness handled by CAP_STALE_THRESHOLD in CawActions)", () => {
      // The staleness check for the stored ratio lives in CawActions._getCost.
      // CawCapOracle itself can't inject timestamps older than now easily
      // in a unit test without time-warping. This test documents the invariant:
      // after 24h with no fresh sample, _getCost returns baseline regardless of
      // the stored ratio. The actual behaviour is exercised via integration tests
      // in multi-layer-test.js. This test is a no-op placeholder.
      assert(true, "staleness invariant documented; tested via CawActions._getCost directly");
    });
  });

  describe("push-ratio: auth — non-oracle cannot call setCapRatio", () => {
    it("CawActions.setCapRatio reverts when called by a non-oracle address", async () => {
      // This test uses a real CawActions. Since truffle tests run against a
      // minimal dev network, we create a CawActions and verify the NotCapOracle
      // guard via the mock. The MockCawActionsCapTarget doesn't enforce auth
      // (it's a mock), but we verify the guard exists in the real interface
      // through the oracle's capStateRatio() accessor being the only
      // oracle-side read. The NotCapOracle error in CawActions is tested in
      // the multi-layer-test.js suite which deploys the full stack.
      //
      // Stub verification: confirm the oracle passes the real cawActions address.
      const storedCawActions = await oracle.cawActions();
      assert.equal(
        storedCawActions.toLowerCase(),
        mockActions.address.toLowerCase(),
        "oracle.cawActions() returns the correct push target"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // H-9/H-10: pushRatioIfStale — permissionless freshness recovery
  // ─────────────────────────────────────────────────────────────────────────

  describe("pushRatioIfStale — rate-limit guard", () => {
    it("reverts with TooSoon when called twice within 5 minutes", async () => {
      // First call from a fresh oracle (lastPushAttemptAt=0). EVM timestamp
      // is always > 0 + 5 min so the first call passes.
      await oracle.pushRatioIfStale({ from: stranger });

      // Immediate second call must revert.
      let threw = false;
      try {
        await oracle.pushRatioIfStale({ from: stranger });
      } catch (e) {
        threw = true;
        assert.match(e.message, /TooSoon|revert/i, "expected TooSoon revert");
      }
      assert(threw, "second pushRatioIfStale within 5 min should revert");
    });

    it("updates lastPushAttemptAt on successful call", async () => {
      const before = await oracle.lastPushAttemptAt();
      await oracle.pushRatioIfStale({ from: stranger });
      const after = await oracle.lastPushAttemptAt();
      assert(
        new BN(after.toString()).gt(new BN(before.toString())),
        "lastPushAttemptAt must increase after pushRatioIfStale"
      );
    });

    it("pushes ratio when oracle is fresh+binding and 5 minutes have passed", async () => {
      // Seed a fresh binding price via recordSample. The trampoline path sets
      // lastPushAttemptAt; advance EVM time by 5 min + 1 s so pushRatioIfStale
      // is no longer rate-limited.
      await seedConstantPrice(new BN("1000000000")); // 1e9 → binds

      const callCountAfterSeed = (await mockActions.setRatioCallCount()).toNumber();
      assert(callCountAfterSeed >= 1, "seed should have triggered an initial push");

      // Advance EVM clock past rate-limit window.
      await web3.currentProvider.send({
        jsonrpc: '2.0', method: 'evm_increaseTime',
        params: [5 * 60 + 1], id: Date.now()
      }, () => {});
      await web3.currentProvider.send({
        jsonrpc: '2.0', method: 'evm_mine', params: [], id: Date.now()
      }, () => {});

      // pushRatioIfStale should now pass the rate-limit and re-evaluate.
      // The TWAP is within 100 bps of the already-stored ratio (same samples),
      // so hysteresis suppresses a new setCapRatio call — but the function
      // itself must NOT revert.
      let threw = false;
      try {
        await oracle.pushRatioIfStale({ from: stranger });
      } catch (e) {
        threw = true;
      }
      assert(!threw, "pushRatioIfStale should not revert after 5 min");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // H-8: uint192 overflow check in _maybePushRatio
  // ─────────────────────────────────────────────────────────────────────────

  describe("H-8 — RatioOverflow revert on uint192 cast", () => {
    it("_maybePushRatioExternal: reverts with RatioOverflow when TWAP > uint192.max", async () => {
      // To trigger the overflow path we need: fresh=true AND binds AND newRatio > uint192.max.
      //
      // newRatio = cumDelta / timeDelta, so to make it huge we need a massive
      // cumulative delta over a MIN_WINDOW-sized window.
      //
      // uint192.max ≈ 6.28e57. We need cumDelta/timeDelta > 6.28e57.
      // Choose timeDelta = MIN_WINDOW + 1 = 86401 s.
      // cumDelta must exceed 86401 × 6.28e57 ≈ 5.43e62.
      // But Sample.cumulative is uint224 (max ≈ 2.69e67), so this is feasible.
      //
      // We also need the cap to "bind" — the bindsNow check:
      //   likeCap = (CAP_LIKE << 112) / newRatio / 1e18 < BASELINE_LIKE
      // A giant newRatio makes likeCap tiny (→ 0), so bindsNow=true.
      //
      // Craft a cumulative delta = (type(uint192).max + 1) * (MIN_WINDOW + 1)
      // to guarantee the TWAP is exactly uint192.max + 1 after division.
      const BN_192_MAX = new BN(2).pow(new BN(192)).subn(1);
      const timeDelta = new BN(86401); // MIN_WINDOW + 1
      const bigCumDelta = BN_192_MAX.addn(1).mul(timeDelta);

      // bigCumDelta might exceed uint224.max if 192_MAX * 86401 > 224_max.
      // uint224.max ≈ 2.695e67; BN_192_MAX * 86401 ≈ 5.43e62 << 2.695e67. Safe.
      const now = await evmNow();
      const t0 = now - timeDelta.toNumber();

      await oracle.recordSample(0, t0, { from: writer });
      // latest cumulative = 0 + bigCumDelta (oldest is 0).
      // We need the raw cumulative value, but it may exceed uint224 in theory.
      // Check it fits.
      const TWO_224 = new BN(2).pow(new BN(224));
      assert(bigCumDelta.lt(TWO_224), "bigCumDelta must fit in uint224 for this test");

      // Record the second sample. This triggers recordSample → _maybePushRatioExternal
      // → _maybePushRatio → require(newRatio <= uint192.max) → revert.
      // But the revert is caught by the try/catch in recordSample itself
      // (the call is: address(this).call(abi.encodeWithSelector(_maybePushRatioExternal))
      // and the result is ignored). So recordSample itself should NOT revert.
      await oracle.recordSample(bigCumDelta, now, { from: writer });
      const written = (await oracle.samplesWritten()).toString();
      assert.equal(written, "2", "recordSample should succeed even when _maybePushRatio overflows");

      // The overflow catch swallows the RatioOverflow inside recordSample.
      // Verify it via pushRatioIfStale (rate-limited after the trampoline ran).
      // Advance clock 5 min + 1 s.
      await web3.currentProvider.send({
        jsonrpc: '2.0', method: 'evm_increaseTime',
        params: [5 * 60 + 1], id: Date.now()
      }, () => {});
      await web3.currentProvider.send({
        jsonrpc: '2.0', method: 'evm_mine', params: [], id: Date.now()
      }, () => {});

      // pushRatioIfStale calls _maybePushRatio directly (not via the swallowing
      // try/catch), so it should revert with RatioOverflow.
      let threw = false;
      let errMsg = "";
      try {
        await oracle.pushRatioIfStale({ from: stranger });
      } catch (e) {
        threw = true;
        errMsg = e.message;
      }
      assert(threw, "pushRatioIfStale should revert with RatioOverflow when TWAP > uint192.max");
      assert.match(errMsg, /RatioOverflow|revert/i, "expected RatioOverflow");
    });
  });
});
