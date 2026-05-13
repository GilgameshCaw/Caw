const CawCapOracle = artifacts.require("CawCapOracle");
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

  beforeEach(async () => {
    oracle = await CawCapOracle.new(writer);
  });

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
      const now = Math.floor(Date.now() / 1000);
      const ancient = now - 7 * 86400; // 7 days ago
      await oracle.recordSample(0, ancient, { from: writer });
      await oracle.recordSample(uqPriceFromWeiPerCaw("1000000").mul(new BN(60)), ancient + 60, { from: writer });

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(cap.toString(), baseline.toString(), "stale oracle should fall back to baseline");
    });
  });

  describe("cap binds with fresh oracle", () => {
    it("does not cap below baseline when CAW is cheap", async () => {
      // CAW is "cheap" if 1 CAW < $0.01 / 2000 = $5e-6, i.e. <1e-9 ETH ≈ 1e9 wei per CAW.
      // Pick 1e8 wei per CAW (CAW worth $5e-7 → like would be ~$0.00025 at baseline)
      const cheapPriceUQ = uqPriceFromWeiPerCaw(new BN("100000000"));
      const now = Math.floor(Date.now() / 1000);
      const t0 = now - 60;
      const t1 = now;

      await oracle.recordSample(0, t0, { from: writer });
      await oracle.recordSample(cheapPriceUQ.mul(new BN(60)), t1, { from: writer });

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();
      assert.equal(
        cap.toString(),
        baseline.toString(),
        "cheap CAW → baseline binds, cap is dormant in the sense of not below baseline"
      );
    });

    it("caps below baseline when CAW is expensive", async () => {
      // Cap math: cappedCaw = ethCap_wei * 1e18 / weiPerCaw  (see capForAction).
      // Break-even for LIKE (baseline 2000): weiPerCaw = 2e11 * 1e18 / 2000 = 1e26.
      // To clamp visibly below baseline, push price 10× higher.
      const expensiveWeiPerCaw = new BN("1000000000000000000000000000"); // 1e27
      const priceUQ = uqPriceFromWeiPerCaw(expensiveWeiPerCaw);
      const now = Math.floor(Date.now() / 1000);

      await oracle.recordSample(0, now - 60, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(60)), now, { from: writer });

      const cap = await oracle.capLike();
      const baseline = await oracle.BASELINE_LIKE();

      assert(
        cap.lt(baseline),
        `expected cap (${cap.toString()}) < baseline (${baseline.toString()}) when CAW is expensive`
      );
      // Expected: 2e11 * 1e18 / 1e27 = 200 (whole CAW)
      assert.equal(cap.toString(), "200", "cap math: 2e11 wei * 1e18 / 1e27 wei-per-CAW = 200 CAW");
    });

    it("preserves ratios across action types", async () => {
      // At a high price where all caps bind, relative cap values should match
      // the baseline ratios (since each cap_i is ethCap_i / price, and the
      // ethCap_i values are constructed as ratios off baseline).
      const expensiveWeiPerCaw = new BN("1000000000000000000000000000"); // 1e27
      const priceUQ = uqPriceFromWeiPerCaw(expensiveWeiPerCaw);
      const now = Math.floor(Date.now() / 1000);

      await oracle.recordSample(0, now - 60, { from: writer });
      await oracle.recordSample(priceUQ.mul(new BN(60)), now, { from: writer });

      const cLike = await oracle.capLike();
      const cRecaw = await oracle.capRecaw();
      const cCaw = await oracle.capCaw();
      const cFollow = await oracle.capFollow();

      // Expected, by ethCap_wei * 1e18 / weiPerCaw with weiPerCaw=1e27:
      //   LIKE:    2e11 * 1e18 / 1e27 =   200
      //   RECAW:   4e11 * 1e18 / 1e27 =   400
      //   CAW:     5e11 * 1e18 / 1e27 =   500
      //   FOLLOW: 30e11 * 1e18 / 1e27 =  3000
      assert.equal(cLike.toString(), "200");
      assert.equal(cRecaw.toString(), "400");
      assert.equal(cCaw.toString(), "500");
      assert.equal(cFollow.toString(), "3000");

      // Ratios match today's baselines (1 : 2 : 2.5 : 15).
      // LIKE : RECAW = 200:400 = 1:2     ✓
      // LIKE : CAW   = 200:500 = 2:5     ✓
      // LIKE : FOLLOW = 200:3000 = 1:15  ✓
    });
  });
});
