import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useSearchParams, Link } from 'react-router-dom'

const ADMIN_TOKEN_KEY = 'caw_admin_token'
const PAGE_SIZE = 50

interface ModelMeta {
  name: string
  label: string
  defaultSort: string
  searchFields: string[]
  listFields: string[]
  writable: boolean
}

const fmtDate = (v: string) => {
  try { return new Date(v).toLocaleString() } catch { return v }
}

const isDateField = (key: string) =>
  key === 'createdAt' || key === 'updatedAt' || key.endsWith('At')

const truncate = (v: string, max = 60) =>
  v.length > max ? v.slice(0, max) + '...' : v

/** Format a cell value for display */
function formatCell(key: string, value: any): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (isDateField(key) && typeof value === 'string') return fmtDate(value)
  if (typeof value === 'object') return truncate(JSON.stringify(value), 80)
  const str = String(value)
  return truncate(str)
}

/** Status badge colors */
function statusColor(value: string): string {
  const v = value.toLowerCase()
  if (v === 'pending' || v === 'processing') return 'bg-yellow-500/20 text-yellow-400'
  if (v === 'done' || v === 'success' || v === 'active') return 'bg-green-500/20 text-green-400'
  if (v === 'failed' || v === 'dismissed') return 'bg-red-500/20 text-red-400'
  if (v === 'reviewed' || v === 'actioned') return 'bg-blue-500/20 text-blue-400'
  if (v === 'sold' || v === 'won') return 'bg-purple-500/20 text-purple-400'
  if (v === 'cancelled' || v === 'expired' || v === 'outbid' || v === 'withdrawn') return 'bg-gray-500/20 text-gray-400'
  return ''
}

const DatabaseAdmin: React.FC = () => {
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()

  // Auth
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '')
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem(ADMIN_TOKEN_KEY))
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  // Models
  const [models, setModels] = useState<ModelMeta[]>([])
  const [activeModel, setActiveModelState] = useState<string>(searchParams.get('model') || '')

  // List view
  const [records, setRecords] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(Number(searchParams.get('offset')) || 0)
  const [sortField, setSortField] = useState(searchParams.get('sort') || '')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>((searchParams.get('order') as 'asc' | 'desc') || 'desc')
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '')
  const [filterField, setFilterField] = useState(searchParams.get('filterField') || '')
  const [filterValue, setFilterValue] = useState(searchParams.get('filterValue') || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Detail view
  const [detailRecord, setDetailRecord] = useState<any>(null)
  const [detailId, setDetailId] = useState<string | null>(searchParams.get('detail') || null)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

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
    } catch {
      setAuthError('Invalid password')
    } finally {
      setAuthLoading(false)
    }
  }

  // Sync URL params
  const setActiveModel = useCallback((model: string) => {
    setActiveModelState(model)
    setOffset(0)
    setSearch('')
    setSearchInput('')
    setFilterField('')
    setFilterValue('')
    setDetailRecord(null)
    setDetailId(null)
    setSearchParams({ model }, { replace: true })
  }, [setSearchParams])

  // Fetch models list
  useEffect(() => {
    if (!authenticated || !token) return
    adminFetch('/api/admin/db/models')
      .then(data => {
        setModels(data.models)
        // If no model selected, pick first one
        if (!activeModel && data.models.length > 0) {
          setActiveModelState(data.models[0].name)
          setSearchParams({ model: data.models[0].name }, { replace: true })
        }
      })
      .catch(() => {
        localStorage.removeItem(ADMIN_TOKEN_KEY)
        setAuthenticated(false)
        setToken('')
      })
  }, [authenticated, token]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch records
  const fetchRecords = useCallback(async () => {
    if (!authenticated || !token || !activeModel) return
    setLoading(true)
    setError('')
    const meta = models.find(m => m.name === activeModel)
    const sort = sortField || meta?.defaultSort || 'id'

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort,
      order: sortOrder,
    })
    if (search) params.set('search', search)
    if (filterField && filterValue) {
      params.set('filter', JSON.stringify({ [filterField]: filterValue }))
    }

    try {
      const data = await adminFetch(`/api/admin/db/${activeModel}?${params}`)
      setRecords(data.records)
      setTotal(data.total)
    } catch (err: any) {
      if (err?.message?.includes('401') || err?.message?.includes('Unauthorized')) {
        localStorage.removeItem(ADMIN_TOKEN_KEY)
        setAuthenticated(false)
        setToken('')
      } else {
        setError(err.message || 'Failed to load data')
      }
    } finally {
      setLoading(false)
    }
  }, [authenticated, token, activeModel, offset, sortField, sortOrder, search, filterField, filterValue, models, adminFetch])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  // Fetch detail
  const fetchDetail = useCallback(async (id: string) => {
    if (!authenticated || !token || !activeModel) return
    try {
      const data = await adminFetch(`/api/admin/db/${activeModel}/${id}`)
      setDetailRecord(data.record)
      setDetailId(id)
      // Initialize edit fields
      const editable: Record<string, string> = {}
      for (const [key, value] of Object.entries(data.record)) {
        if (key === 'id' || key === 'createdAt') continue
        editable[key] = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
      }
      setEditFields(editable)
      setSaveMsg('')
    } catch (err: any) {
      setError(err.message || 'Failed to load record')
    }
  }, [authenticated, token, activeModel, adminFetch])

  // Save edits
  const saveRecord = async () => {
    if (!detailId || !activeModel) return
    const meta = models.find(m => m.name === activeModel)
    if (!meta?.writable) return

    setSaving(true)
    setSaveMsg('')
    try {
      // Build update payload — only send changed fields
      const updates: Record<string, any> = {}
      for (const [key, value] of Object.entries(editFields)) {
        const original = detailRecord[key]
        const originalStr = typeof original === 'object' ? JSON.stringify(original) : String(original ?? '')
        if (value !== originalStr) {
          // Try to parse JSON for object fields
          try {
            updates[key] = JSON.parse(value)
          } catch {
            // Try number
            const num = Number(value)
            updates[key] = !isNaN(num) && value.trim() !== '' && !value.includes('-') && !value.includes('T') ? num : value
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        setSaveMsg('No changes')
        setSaving(false)
        return
      }

      const data = await adminFetch(`/api/admin/db/${activeModel}/${detailId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
      setDetailRecord(data.record)
      setSaveMsg('Saved')
      fetchRecords() // Refresh list
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Delete record
  const deleteRecord = async () => {
    if (!detailId || !activeModel) return
    if (!confirm('Are you sure you want to delete this record?')) return
    try {
      await adminFetch(`/api/admin/db/${activeModel}/${detailId}`, { method: 'DELETE' })
      setDetailRecord(null)
      setDetailId(null)
      fetchRecords()
    } catch (err: any) {
      setSaveMsg(`Delete failed: ${err.message}`)
    }
  }

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
    setOffset(0)
  }

  const activeMeta = models.find(m => m.name === activeModel)
  const columns = activeMeta?.listFields || (records[0] ? Object.keys(records[0]) : [])
  const allFields = detailRecord ? Object.keys(detailRecord) : []

  // Color scheme
  const bg = isDark ? 'bg-black' : 'bg-gray-50'
  const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
  const text = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/50' : 'text-gray-500'
  const hover = isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50'
  const input = isDark
    ? 'bg-black border-white/20 text-white placeholder-white/30'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'

  // Login gate
  if (!authenticated) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${bg}`}>
        <div className={`p-8 rounded-2xl border max-w-sm w-full ${card}`}>
          <h1 className={`text-xl font-bold mb-4 ${text}`}>Database Admin</h1>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && login()}
            placeholder="Admin password"
            className={`w-full px-3 py-2 rounded-lg border text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${input}`}
          />
          {authError && <p className="text-red-500 text-xs mb-2">{authError}</p>}
          <button
            onClick={login}
            disabled={authLoading}
            className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {authLoading ? 'Logging in...' : 'Login'}
          </button>
        </div>
      </div>
    )
  }

  // Detail view
  if (detailRecord && detailId) {
    const idField = activeModel === 'validatorSetting' || activeModel === 'chainData' ? 'key' : 'id'
    return (
      <div className={`min-h-screen ${bg} p-4`}>
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => { setDetailRecord(null); setDetailId(null) }}
              className={`flex items-center gap-1.5 text-sm font-medium transition-colors ${
                isDark ? 'text-white/70 hover:text-white' : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
              </svg>
              {activeMeta?.label || activeModel}
            </button>
            <span className={muted}>/</span>
            <h2 className={`text-lg font-bold ${text}`}>
              #{detailRecord[idField]}
            </h2>
            {activeMeta?.writable && (
              <div className="flex gap-2 ml-auto">
                <button
                  onClick={saveRecord}
                  disabled={saving}
                  className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={deleteRecord}
                  className="text-sm px-4 py-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30"
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          {saveMsg && (
            <div className={`text-sm mb-3 ${saveMsg.startsWith('Error') || saveMsg.startsWith('Delete') ? 'text-red-400' : 'text-green-400'}`}>
              {saveMsg}
            </div>
          )}

          {/* Fields */}
          <div className={`rounded-xl border ${card} divide-y ${isDark ? 'divide-white/10' : 'divide-gray-100'}`}>
            {allFields.map(key => {
              const value = detailRecord[key]
              const isReadOnly = key === 'id' || key === 'createdAt' || !activeMeta?.writable
              const isJson = typeof value === 'object' && value !== null
              const isLong = isJson || (typeof value === 'string' && value.length > 100)

              return (
                <div key={key} className="flex gap-4 px-4 py-3">
                  <div className={`w-40 shrink-0 text-sm font-mono ${muted}`}>{key}</div>
                  <div className="flex-1 min-w-0">
                    {isReadOnly ? (
                      <div className={`text-sm ${text} break-all`}>
                        {isDateField(key) && typeof value === 'string' ? fmtDate(value) :
                         isJson ? <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre> :
                         String(value ?? '-')}
                      </div>
                    ) : isLong ? (
                      <textarea
                        value={editFields[key] ?? ''}
                        onChange={e => setEditFields(prev => ({ ...prev, [key]: e.target.value }))}
                        rows={Math.min(isJson ? 8 : 4, 12)}
                        className={`w-full px-2 py-1 rounded border text-sm font-mono ${input}`}
                      />
                    ) : (
                      <input
                        value={editFields[key] ?? ''}
                        onChange={e => setEditFields(prev => ({ ...prev, [key]: e.target.value }))}
                        className={`w-full px-2 py-1 rounded border text-sm ${input}`}
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // List view
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className={`min-h-screen ${bg}`}>
      <div className="flex min-h-screen">
        {/* Sidebar — model list */}
        <div className={`w-52 shrink-0 border-r ${isDark ? 'border-white/10' : 'border-gray-200'} p-3 overflow-y-auto`}>
          <Link
            to="/admin"
            className={`flex items-center gap-2 px-3 py-2 mb-3 rounded-lg text-sm font-medium transition-colors ${
              isDark ? 'text-white/70 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
            Admin
          </Link>
          <h2 className={`text-xs font-bold px-3 mb-2 ${muted}`}>Tables</h2>
          {models.map(m => (
            <button
              key={m.name}
              onClick={() => setActiveModel(m.name)}
              className={`w-full text-left px-3 py-1.5 rounded-lg text-sm mb-0.5 transition-colors ${
                activeModel === m.name
                  ? (isDark ? 'bg-white/10 text-white font-medium' : 'bg-blue-50 text-blue-700 font-medium')
                  : `${text} ${hover}`
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Main content */}
        <div className="flex-1 p-4 overflow-x-auto">
          {/* Toolbar */}
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <h1 className={`text-lg font-bold ${text}`}>{activeMeta?.label || activeModel}</h1>
            <span className={`text-sm ${muted}`}>{total.toLocaleString()} records</span>

            {/* Search */}
            {activeMeta && activeMeta.searchFields.length > 0 && (
              <div className="flex items-center gap-1">
                <input
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      setSearch(searchInput)
                      setOffset(0)
                    }
                  }}
                  placeholder={`Search ${activeMeta.searchFields.join(', ')}...`}
                  className={`px-2 py-1 rounded-lg border text-sm w-48 ${input}`}
                />
                {search && (
                  <button
                    onClick={() => { setSearch(''); setSearchInput(''); setOffset(0) }}
                    className={`text-xs px-2 py-1 rounded ${muted} ${hover}`}
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* Filter */}
            <div className="flex items-center gap-1">
              <select
                value={filterField}
                onChange={e => { setFilterField(e.target.value); setFilterValue(''); setOffset(0) }}
                className={`px-2 py-1 rounded-lg border text-sm ${input}`}
              >
                <option value="">Filter by...</option>
                {columns.map(col => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
              {filterField && (
                <input
                  value={filterValue}
                  onChange={e => setFilterValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { setOffset(0); fetchRecords() } }}
                  placeholder="value"
                  className={`px-2 py-1 rounded-lg border text-sm w-32 ${input}`}
                />
              )}
              {filterField && filterValue && (
                <button
                  onClick={() => { setFilterField(''); setFilterValue(''); setOffset(0) }}
                  className={`text-xs px-2 py-1 rounded ${muted} ${hover}`}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Refresh */}
            <button
              onClick={fetchRecords}
              className={`text-sm px-3 py-1 rounded-lg border ${card} ${text} ${hover}`}
            >
              Refresh
            </button>
          </div>

          {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

          {/* Table */}
          <div className={`rounded-xl border overflow-hidden ${card}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-white/5' : 'bg-gray-50'}>
                  {columns.map(col => (
                    <th
                      key={col}
                      onClick={() => handleSort(col)}
                      className={`px-3 py-2 text-left font-medium cursor-pointer select-none whitespace-nowrap ${muted} hover:${text}`}
                    >
                      {col}
                      {sortField === col && (
                        <span className="ml-1">{sortOrder === 'desc' ? '▼' : '▲'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={isDark ? 'divide-y divide-white/5' : 'divide-y divide-gray-100'}>
                {loading && records.length === 0 ? (
                  <tr><td colSpan={columns.length} className={`px-3 py-8 text-center ${muted}`}>Loading...</td></tr>
                ) : records.length === 0 ? (
                  <tr><td colSpan={columns.length} className={`px-3 py-8 text-center ${muted}`}>No records found</td></tr>
                ) : records.map((record, i) => {
                  const idField = activeModel === 'validatorSetting' || activeModel === 'chainData' ? 'key' : 'id'
                  const id = record[idField]
                  return (
                    <tr
                      key={id ?? i}
                      onClick={() => fetchDetail(String(id))}
                      className={`cursor-pointer ${hover} transition-colors`}
                    >
                      {columns.map(col => {
                        const val = record[col]
                        const isStatus = col === 'status' || col === 'action'
                        const statusCls = isStatus && typeof val === 'string' ? statusColor(val) : ''
                        return (
                          <td key={col} className={`px-3 py-2 whitespace-nowrap ${text}`}>
                            {statusCls ? (
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusCls}`}>
                                {val}
                              </span>
                            ) : (
                              formatCell(col, val)
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className={`text-sm px-3 py-1 rounded-lg border ${card} ${text} disabled:opacity-30`}
              >
                Prev
              </button>
              <span className={`text-sm ${muted}`}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className={`text-sm px-3 py-1 rounded-lg border ${card} ${text} disabled:opacity-30`}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default DatabaseAdmin
