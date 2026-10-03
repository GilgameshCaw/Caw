import { expect } from 'chai'
import {
  parseUsernameDriftReconcileIntervalMinutes,
  shouldReconcileUsernameDrift,
} from '../../../src/services/DataCleaner/usernameDriftInterval'

describe('DataCleaner / username-drift reconcile interval', () => {
  describe('parseUsernameDriftReconcileIntervalMinutes', () => {
    it('defaults to 60 when unset or blank', () => {
      expect(parseUsernameDriftReconcileIntervalMinutes(undefined)).to.equal(60)
      expect(parseUsernameDriftReconcileIntervalMinutes('')).to.equal(60)
      expect(parseUsernameDriftReconcileIntervalMinutes('   ')).to.equal(60)
    })

    it('accepts configured non-negative values', () => {
      expect(parseUsernameDriftReconcileIntervalMinutes('60')).to.equal(60)
      expect(parseUsernameDriftReconcileIntervalMinutes('1')).to.equal(1)
      expect(parseUsernameDriftReconcileIntervalMinutes('0')).to.equal(0)
    })

    it('falls back to 60 for invalid or negative values', () => {
      expect(parseUsernameDriftReconcileIntervalMinutes('invalid')).to.equal(60)
      expect(parseUsernameDriftReconcileIntervalMinutes('-1')).to.equal(60)
      expect(parseUsernameDriftReconcileIntervalMinutes('Infinity')).to.equal(60)
    })
  })

  describe('shouldReconcileUsernameDrift', () => {
    const HOUR = 60 * 60_000

    it('disables reconciliation when interval is zero', () => {
      expect(shouldReconcileUsernameDrift(10_000, 0, 0)).to.equal(false)
    })

    it('runs immediately when there is no previous run', () => {
      expect(shouldReconcileUsernameDrift(10_000, 0, HOUR)).to.equal(true)
    })

    it('does not run before the interval has elapsed', () => {
      expect(
        shouldReconcileUsernameDrift(HOUR - 1, 1, HOUR),
      ).to.equal(false)
    })

    it('runs exactly when the interval has elapsed', () => {
      expect(
        shouldReconcileUsernameDrift(HOUR + 1, 1, HOUR),
      ).to.equal(true)
    })
  })
})
