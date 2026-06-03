import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { Link } from '~/utils/localizedRouter'
interface SettingField {
  key: string
  label: string
  description: string
  default: number | boolean
  kind?: 'number' | 'boolean'
}

const SETTINGS_FIELDS: SettingField[] = [
  { key: 'validatorBaseTip', label: 'Base Validator Tip (CAW)', default: 1000,
    description: 'Minimum CAW tip required per action. Actions below this are rejected. This is the "Cheap" tier in the Quick Sign speed picker.' },
  { key: 'priorityTip', label: 'Priority Tip (CAW)', default: 3000,
    description: 'Tip threshold for priority processing. Actions at or above this value skip the batch wait and get processed on the next poll cycle (~2s instead of ~10s). This is the "Fast" tier in Quick Sign. Default is 3× the base tip.' },
  { key: 'checkInterval', label: 'Poll Interval (ms)', default: 10000,
    description: 'How often the validator checks for new pending actions in the queue. Lower values mean faster processing but more RPC calls.' },
  { key: 'minActionsPerBatch', label: 'Min Actions Per Batch', default: 1,
    description: 'Minimum number of actions to accumulate before submitting a transaction. Higher values reduce gas cost per action but increase user wait time.' },
  { key: 'maxWaitTime', label: 'Max Wait Time (ms)', default: 60000,
    description: 'Maximum time an action can sit in the queue before being force-submitted, even if the batch is smaller than the minimum. Prevents users from waiting too long during low activity.' },
  { key: 'replicationInterval', label: 'Replication Interval (ms)', default: 60000,
    description: 'How often the background replication loop checks for completed 256-action checkpoints that need to be archived to other chains via LayerZero.' },
  { key: 'acceptZeroTip', label: 'Accept Zero-Tip Actions', default: false, kind: 'boolean',
    description: 'If enabled, this validator processes actions that include no tip at all (public-goods mode). Users who choose "No tip" in Quick Sign rely on validators that opt into this. You will pay LayerZero fees out of pocket for these actions — only enable if you want to subsidize free posting.' },
  { key: 'minTipPerActionWei', label: 'Min Tip Per Action (ETH wei)', default: 450000000000,
    description: 'ETH-denominated per-action floor. The on-chain oracle converts to CAW at submission. The FE Quick Sign step reads this to show users the "Tip / action" cost in USD before they sign. Leave at 0 to impose no ETH floor (the CAW base tip above still applies). Default 450000000000 wei ≈ $0.0009/action at $2000/ETH (conservative anchor).' },
]

const ValidatorSettings: React.FC = () => {
  const { isDark } = useTheme()

  // Settings state
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/api/validator-analytics/settings') as Record<string, any>
      const vals: Record<string, string> = {}
      for (const field of SETTINGS_FIELDS) {
        vals[field.key] = data[field.key] !== undefined ? String(data[field.key]) : String(field.default)
      }
      setValues(vals)
    } catch {
      setError('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // Pre-flight check: enforce priorityTip >= validatorBaseTip on the client
  // so the user gets instant feedback before the round-trip. Server enforces
  // the same invariant (validator-analytics.ts) — this is just UX polish.
  // Returns null when the save is OK, or a user-facing error string.
  function preflightTipOrdering(key: string, raw: string): string | null {
    if (key !== 'validatorBaseTip' && key !== 'priorityTip') return null
    let nextVal: bigint
    try { nextVal = BigInt(raw) } catch { return null }  // let server reject as malformed
    const otherKey = key === 'validatorBaseTip' ? 'priorityTip' : 'validatorBaseTip'
    const otherRaw = values[otherKey]
    if (otherRaw == null || otherRaw === '') return null
    let otherVal: bigint
    try { otherVal = BigInt(otherRaw) } catch { return null }
    const base = key === 'validatorBaseTip' ? nextVal : otherVal
    const priority = key === 'priorityTip' ? nextVal : otherVal
    if (priority < base) {
      return `Priority Tip (${priority}) must be ≥ Base Validator Tip (${base}). Fast-tier price can't be cheaper than the minimum the validator accepts.`
    }
    return null
  }

  const saveSetting = async (key: string) => {
    const localErr = preflightTipOrdering(key, values[key])
    if (localErr) {
      setError(localErr)
      return
    }
    setError('')
    setSaving(prev => ({ ...prev, [key]: true }))
    setSaved(prev => ({ ...prev, [key]: false }))
    try {
      await apiFetch('/api/validator-analytics/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key, value: values[key] })
      })
      setSaved(prev => ({ ...prev, [key]: true }))
      setTimeout(() => setSaved(prev => ({ ...prev, [key]: false })), 2000)
    } catch (err: any) {
      // Surface the server's error code/message when present (e.g. the
      // priority-below-base guard); fall back to a generic blurb otherwise.
      const msg = String(err?.message || '')
      if (msg.includes('priority_below_base')) {
        setError(`Priority Tip must be ≥ Base Validator Tip. Adjust one and retry.`)
      } else {
        setError(`Failed to save ${key}${msg ? `: ${msg}` : ''}`)
      }
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }))
    }
  }

  const cardClass = `rounded-xl border p-4 ${isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'}`

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <Link to="/admin" className={`text-sm transition-colors ${isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'}`}>Admin</Link>
            <span className={isDark ? 'text-white/20' : 'text-gray-300'}>/</span>
            <Link to="/admin/validator" className={`text-sm transition-colors ${isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'}`}>Analytics</Link>
            <span className={isDark ? 'text-white/20' : 'text-gray-300'}>/</span>
            <h1 className="text-2xl font-bold">Settings</h1>
          </div>
        </div>
        <p className={`text-sm mb-6 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
          Configure how the validator processes and submits actions. Changes take effect on the next poll cycle.
        </p>

        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        {loading && <p className={`mb-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Loading...</p>}

        <div className="space-y-4">
          {SETTINGS_FIELDS.map(field => (
            <div key={field.key} className={cardClass}>
              <label className={`text-sm font-medium block mb-1 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                {field.label}
              </label>
              <p className={`text-xs mb-3 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                {field.description}
              </p>
              <div className="flex items-center gap-3">
                {field.kind === 'boolean' ? (
                  <label className="flex items-center gap-2 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={values[field.key] === 'true'}
                      onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.checked ? 'true' : 'false' }))}
                      className="w-4 h-4 cursor-pointer"
                    />
                    <span className={`text-sm ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                      {values[field.key] === 'true' ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                ) : (
                  <input
                    type="number"
                    value={values[field.key] ?? String(field.default)}
                    onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
                      isDark
                        ? 'bg-white/5 border-white/10 text-white'
                        : 'bg-gray-50 border-gray-200 text-gray-900'
                    }`}
                  />
                )}
                <button
                  onClick={() => saveSetting(field.key)}
                  disabled={saving[field.key]}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
                    saved[field.key]
                      ? 'bg-green-500 text-white'
                      : 'bg-blue-500 text-white hover:bg-blue-600'
                  }`}
                >
                  {saving[field.key] ? 'Saving...' : saved[field.key] ? 'Saved' : 'Save'}
                </button>
              </div>
              <p className={`text-xs mt-1 ${isDark ? 'text-white/20' : 'text-gray-400'}`}>
                Default: {String(field.default)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default ValidatorSettings
