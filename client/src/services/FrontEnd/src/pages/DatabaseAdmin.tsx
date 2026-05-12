import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useSearchParams } from 'react-router-dom'
import { Link } from '~/utils/localizedRouter'
import { decompressSignedText } from '~/api/actions'

const PAGE_SIZE = 50

const ACTION_TYPE_LABELS: Record<number, string> = {
  0: 'CAW',
  1: 'LIKE',
  2: 'UNLIKE',
  3: 'RECAW',
  4: 'FOLLOW',
  5: 'UNFOLLOW',
  6: 'WITHDRAW',
  7: 'OTHER',
}

/** For txQueue records, extract payload.data fields into flat columns for the list view. */
function flattenTxQueueRecord(record: any): any {
  const payload = record.payload
  const data = payload?.data
  if (!data) return { ...record, actionType: '-', receiverId: '-', receiverCawonce: '-', cawonce: '-', clientId: '-', recipients: '-', amounts: '-', text: '-' }
  const actionCode = typeof data.actionType === 'number' ? data.actionType : parseInt(data.actionType)
  const actionLabel = ACTION_TYPE_LABELS[actionCode] ?? String(data.actionType)
  let text = '-'
  if (data.text && data.text !== '0x') {
    try { text = decompressSignedText(data.text) } catch { text = String(data.text).slice(0, 60) }
  }
  const amounts = Array.isArray(data.amounts) && data.amounts.length > 0
    ? data.amounts.join(', ')
    : '-'
  const recipients = Array.isArray(data.recipients) && data.recipients.length > 0
    ? data.recipients.join(', ')
    : '-'
  return {
    ...record,
    actionType: actionLabel,
    receiverId: data.receiverId ?? '-',
    receiverCawonce: data.receiverCawonce ?? '-',
    cawonce: data.cawonce ?? '-',
    clientId: data.clientId ?? '-',
    recipients,
    amounts,
    text: text.length > 80 ? text.slice(0, 80) + '...' : text,
  }
}

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

/** Format a cell value for display.
 *
 * For numeric *Id fields (senderId, recipientId, etc.) the backend stamps a
 * synthetic `*Username` sibling on each record so we can render
 * `"99 (gilga99)"` instead of bare token IDs — much easier to scan when
 * triaging tx-queue rows. */
function formatCell(key: string, value: any, record?: any): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (isDateField(key) && typeof value === 'string') return fmtDate(value)
  if (typeof value === 'object') return truncate(JSON.stringify(value), 80)
  if (record && key.endsWith('Id')) {
    const uname = record[`${key}Username`]
    if (uname) return `${value} (${uname})`
  }
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

  // "Execute batch now" state — admin force-kick of the validator's
  // pending TxQueue. Result is shown next to the button for a few seconds.
  const [executingBatch, setExecutingBatch] = useState(false)
  const [batchResult, setBatchResult] = useState<string | null>(null)

  // Detail view
  const [detailRecord, setDetailRecord] = useState<any>(null)
  const [detailId, setDetailId] = useState<string | null>(searchParams.get('detail') || null)
  const [editFields, setEditFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // Go back from detail to list view
  const closeDetail = useCallback(() => {
    setDetailRecord(null)
    setDetailId(null)
  }, [])

  // Escape key goes back to list view
  useEffect(() => {
    if (!detailRecord) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // If focused on an input/textarea, blur it first; next Escape closes detail
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        e.target.blur()
        return
      }
      closeDetail()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [detailRecord, closeDetail])

  // Sync all state to URL params
  useEffect(() => {
    const params: Record<string, string> = {}
    if (activeModel) params.model = activeModel
    if (offset) params.offset = String(offset)
    if (sortField) params.sort = sortField
    if (sortOrder !== 'desc') params.order = sortOrder
    if (search) params.search = search
    if (filterField) params.filterField = filterField
    if (filterValue) params.filterValue = filterValue
    if (detailId) params.detail = detailId
    setSearchParams(params, { replace: true })
  }, [activeModel, offset, sortField, sortOrder, search, filterField, filterValue, detailId, setSearchParams])

  const setActiveModel = useCallback((model: string) => {
    setActiveModelState(model)
    setOffset(0)
    setSearch('')
    setSearchInput('')
    setFilterField('')
    setFilterValue('')
    setSortField('')
    setSortOrder('desc')
    closeDetail()
  }, [closeDetail])

  // Fetch models list — AdminGate guarantees we're authenticated
  useEffect(() => {
    apiFetch('/api/admin/db/models')
      .then(data => {
        setModels(data.models)
        if (!activeModel && data.models.length > 0) {
          setActiveModelState(data.models[0].name)
        }
      })
      .catch(() => { /* AdminGate will catch 401s on next navigation */ })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch records
  const fetchRecords = useCallback(async () => {
    if (!activeModel) return
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
      const data = await apiFetch(`/api/admin/db/${activeModel}?${params}`)
      const records = activeModel === 'txQueue' ? data.records.map(flattenTxQueueRecord) : data.records
      setRecords(records)
      setTotal(data.total)
    } catch (err: any) {
      setError(err.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [activeModel, offset, sortField, sortOrder, search, filterField, filterValue, models])

  useEffect(() => { fetchRecords() }, [fetchRecords])

  // Fetch detail
  const fetchDetail = useCallback(async (id: string) => {
    if (!activeModel) return
    try {
      const data = await apiFetch(`/api/admin/db/${activeModel}/${id}`)
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
  }, [activeModel])

  // Hydrate from URL: when ?detail=… is present at load (or after a
  // tab-restore / Cmd+click into a new tab), pull the record so the
  // detail panel renders without a row click.
  useEffect(() => {
    if (!detailId || !activeModel || detailRecord) return
    fetchDetail(detailId)
  }, [detailId, activeModel, detailRecord, fetchDetail])

  // Build the URL that represents a given (model, detailId). Used both
  // as the href for native browser middle-click / Cmd+click and to
  // open new tabs programmatically when a click handler intercepts.
  const buildUrl = useCallback((model: string, detail?: string | null) => {
    const params = new URLSearchParams()
    if (model) params.set('model', model)
    if (detail) params.set('detail', detail)
    const qs = params.toString()
    return qs ? `/admin/db?${qs}` : '/admin/db'
  }, [])

  // Cmd/Ctrl/middle-click → new tab; plain click → in-page handler.
  // Returning true means "the click was handled as a new-tab open;
  // caller should not run its in-page logic."
  const openNewTabIfModified = (
    e: React.MouseEvent,
    url: string,
  ): boolean => {
    if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) {
      e.preventDefault()
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    }
    return false
  }

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

      const data = await apiFetch(`/api/admin/db/${activeModel}/${detailId}`, {
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
      await apiFetch(`/api/admin/db/${activeModel}/${detailId}`, { method: 'DELETE' })
      closeDetail()
      fetchRecords()
    } catch (err: any) {
      setSaveMsg(`Delete failed: ${err.message}`)
    }
  }

  // Force the validator to drain its pending TxQueue on the next tick
  // (which we also fire immediately) instead of waiting for batch
  // accumulation. On api-only nodes the server reports triggered=false
  // and we surface that so the operator knows the call hit the wrong
  // node. Result clears itself after 6s.
  const handleExecuteBatchNow = useCallback(async () => {
    if (executingBatch) return
    setExecutingBatch(true)
    setBatchResult(null)
    try {
      const r = await apiFetch('/api/admin/validator/execute-batch-now', { method: 'POST' })
      if (r.triggered) {
        setBatchResult(`✓ Triggered (${r.pendingCount ?? '?'} pending)`)
      } else {
        setBatchResult(`No validator on this node: ${r.reason ?? 'unknown'}`)
      }
      // Refresh the table so the operator sees rows flipping out of pending.
      fetchRecords()
    } catch (err: any) {
      setBatchResult(`Failed: ${err?.message || 'unknown error'}`)
    } finally {
      setExecutingBatch(false)
      setTimeout(() => setBatchResult(null), 6000)
    }
  }, [executingBatch, fetchRecords])

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

  // Detail view
  if (detailRecord && detailId) {
    const idField = activeModel === 'validatorSetting' || activeModel === 'chainData' ? 'key' : 'id'
    return (
      <div className={`min-h-screen ${bg} p-4`}>
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={closeDetail}
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
            <a
              key={m.name}
              href={buildUrl(m.name)}
              onClick={(e) => {
                if (openNewTabIfModified(e, buildUrl(m.name))) return
                e.preventDefault()
                setActiveModel(m.name)
              }}
              className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm mb-0.5 transition-colors ${
                activeModel === m.name
                  ? (isDark ? 'bg-white/10 text-white font-medium' : 'bg-blue-50 text-blue-700 font-medium')
                  : `${text} ${hover}`
              }`}
            >
              {m.label}
            </a>
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

            {/* Execute batch now — push to the right end of the toolbar.
                Forces the validator to process all pending TxQueue rows
                immediately instead of waiting for batch accumulation. */}
            <div className="ml-auto flex items-center gap-2">
              {batchResult && (
                <span className={`text-xs ${muted}`}>{batchResult}</span>
              )}
              <button
                onClick={handleExecuteBatchNow}
                disabled={executingBatch}
                title="Tell the validator to process every pending TxQueue now, skipping batch wait"
                className={`text-sm px-3 py-1 rounded-lg border ${card} ${text} ${hover} ${executingBatch ? 'opacity-50 cursor-wait' : ''}`}
              >
                {executingBatch ? 'Executing…' : 'Execute batch now'}
              </button>
            </div>
          </div>

          {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

          {/* Table */}
          <div className={`rounded-xl border overflow-hidden ${card}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className={isDark ? 'bg-white/5' : 'bg-gray-50'}>
                  {columns.map(col => {
                    // The txQueue `text` column can hold long post bodies;
                    // cap it so the rest of the row stays readable.
                    const isText = col === 'text'
                    return (
                      <th
                        key={col}
                        onClick={() => handleSort(col)}
                        style={isText ? { width: 100, maxWidth: 100 } : undefined}
                        className={`px-3 py-2 text-left font-medium cursor-pointer select-none whitespace-nowrap ${muted} hover:${text}`}
                      >
                        {col}
                        {sortField === col && (
                          <span className="ml-1">{sortOrder === 'desc' ? '▼' : '▲'}</span>
                        )}
                      </th>
                    )
                  })}
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
                      onClick={(e) => {
                        if (openNewTabIfModified(e, buildUrl(activeModel, String(id)))) return
                        fetchDetail(String(id))
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) openNewTabIfModified(e, buildUrl(activeModel, String(id)))
                      }}
                      className={`cursor-pointer ${hover} transition-colors`}
                    >
                      {columns.map(col => {
                        const val = record[col]
                        const isStatus = col === 'status' || col === 'action'
                        const statusCls = isStatus && typeof val === 'string' ? statusColor(val) : ''
                        const isText = col === 'text'
                        return (
                          <td
                            key={col}
                            style={isText ? { width: 100, maxWidth: 100 } : undefined}
                            className={`px-3 py-2 whitespace-nowrap ${text} ${isText ? 'overflow-hidden text-ellipsis' : ''}`}
                            title={isText && typeof val === 'string' ? val : undefined}
                          >
                            {statusCls ? (
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusCls}`}>
                                {val}
                              </span>
                            ) : (
                              formatCell(col, val, record)
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
