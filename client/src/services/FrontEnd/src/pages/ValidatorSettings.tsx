import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { Link } from 'react-router-dom'

const ADMIN_TOKEN_KEY = 'caw_admin_token'

interface SettingField {
  key: string
  label: string
  description: string
  default: number
}

const SETTINGS_FIELDS: SettingField[] = [
  { key: 'validatorBaseTip', label: 'Base Validator Tip (CAW)', default: 1000,
    description: 'Minimum CAW tip required per action. Users must include at least this amount as a validator fee. Higher values increase revenue but may discourage usage.' },
  { key: 'checkInterval', label: 'Poll Interval (ms)', default: 10000,
    description: 'How often the validator checks for new pending actions in the queue. Lower values mean faster processing but more RPC calls.' },
  { key: 'minActionsPerBatch', label: 'Min Actions Per Batch', default: 1,
    description: 'Minimum number of actions to accumulate before submitting a transaction. Higher values reduce gas cost per action but increase user wait time.' },
  { key: 'maxWaitTime', label: 'Max Wait Time (ms)', default: 60000,
    description: 'Maximum time an action can sit in the queue before being force-submitted, even if the batch is smaller than the minimum. Prevents users from waiting too long during low activity.' },
  { key: 'replicationInterval', label: 'Replication Interval (ms)', default: 60000,
    description: 'How often the background replication loop checks for completed 256-action checkpoints that need to be archived to other chains via LayerZero.' }
]

const ValidatorSettings: React.FC = () => {
  const { isDark } = useTheme()

  // Auth state — persist in localStorage
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '')
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem(ADMIN_TOKEN_KEY))
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  // Settings state
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const adminFetch = useCallback(async (path: string, init?: RequestInit) => {
    return apiFetch(path, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> || {}),
        'Authorization': `Bearer ${token}`
      }
    })
  }, [token])

  const login = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const data = await apiFetch('/api/bug-reports/login', {
        method: 'POST',
        body: JSON.stringify({ password })
      })
      localStorage.setItem(ADMIN_TOKEN_KEY, data.token)
      setToken(data.token)
      setAuthenticated(true)
      setPassword('')
    } catch {
      setAuthError('Invalid password')
    } finally {
      setAuthLoading(false)
    }
  }

  const fetchSettings = useCallback(async () => {
    if (!authenticated || !token) return
    setLoading(true)
    setError('')
    try {
      const data = await adminFetch('/api/validator-analytics/settings')
      const vals: Record<string, string> = {}
      for (const field of SETTINGS_FIELDS) {
        vals[field.key] = data[field.key] !== undefined ? String(data[field.key]) : String(field.default)
      }
      setValues(vals)
    } catch {
      setError('Failed to load settings')
      localStorage.removeItem(ADMIN_TOKEN_KEY)
      setAuthenticated(false)
      setToken('')
    } finally {
      setLoading(false)
    }
  }, [authenticated, token, adminFetch])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const saveSetting = async (key: string) => {
    setSaving(prev => ({ ...prev, [key]: true }))
    setSaved(prev => ({ ...prev, [key]: false }))
    try {
      await adminFetch('/api/validator-analytics/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key, value: values[key] })
      })
      setSaved(prev => ({ ...prev, [key]: true }))
      setTimeout(() => setSaved(prev => ({ ...prev, [key]: false })), 2000)
    } catch {
      setError(`Failed to save ${key}`)
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }))
    }
  }

  const cardClass = `rounded-xl border p-4 ${isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'}`

  // Login gate
  if (!authenticated) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-black' : 'bg-gray-50'}`}>
        <div className={`p-8 rounded-2xl border max-w-sm w-full ${
          isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
        }`}>
          <h1 className={`text-xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Validator Settings
          </h1>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && login()}
            placeholder="Admin password"
            className={`w-full px-3 py-2 rounded-lg border text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
              isDark
                ? 'bg-white/5 border-white/10 text-white placeholder-white/30'
                : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
            }`}
          />
          {authError && <p className="text-red-500 text-xs mb-3">{authError}</p>}
          <button
            onClick={login}
            disabled={authLoading}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm cursor-pointer disabled:opacity-50"
          >
            {authLoading ? 'Logging in...' : 'Login'}
          </button>
        </div>
      </div>
    )
  }

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
                Default: {field.default}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default ValidatorSettings
