import { useState, useEffect, useCallback } from 'react'

interface ProviderStatus {
  name: string
  key: string
  modelCount: number
  lastUpdated: string | null
  hasScript: boolean
  refreshing: boolean
}

interface BenchmarkSourceStatus {
  key: string
  refreshing: boolean
}

interface BenchmarkStatus {
  entryCount: number
  lastUpdated: string | null
  refreshing: boolean
  sources?: BenchmarkSourceStatus[]
}

const BENCHMARK_SOURCE_NAMES: Record<string, string> = {
  llmstats:  'LLMStats',
  hf:        'HF Leaderboard',
  livebench: 'LiveBench',
  arena:     'Chatbot Arena',
  aider:     'Aider',
}

interface FetchResult {
  provider: string
  success: boolean
  error?: string
}

function formatAge(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

interface Props {
  onClose: () => void
  onDataUpdated: () => void
}

export function ManagementPanel({ onClose, onDataUpdated }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [benchmarks, setBenchmarks] = useState<BenchmarkStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; error?: string }>>({})
  const [bmResult, setBmResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [bmSourceResults, setBmSourceResults] = useState<Record<string, { success: boolean; error?: string }>>({})
  const [refreshingBmSource, setRefreshingBmSource] = useState<Record<string, boolean>>({})
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [serverAvailable, setServerAvailable] = useState(true)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setProviders(data.providers)
      if (data.benchmarks) setBenchmarks(data.benchmarks)
      setServerAvailable(true)
      setError(null)
    } catch (e: any) {
      setServerAvailable(false)
      setError('Management server not running. Start it with: node server.js')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const refreshProvider = async (key: string, name: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.name === name ? { ...p, refreshing: true } : p))
    )
    setResults((r) => ({ ...r, [name]: { success: false } }))

    try {
      const res = await fetch(`/api/fetch/${key}`, { method: 'POST' })
      const data: FetchResult = await res.json()
      setResults((r) => ({ ...r, [name]: { success: data.success, error: data.error } }))
      if (data.success) onDataUpdated()
    } catch {
      setResults((r) => ({ ...r, [name]: { success: false, error: 'Request failed' } }))
    }

    await fetchStatus()
  }

  const refreshBenchmarks = async () => {
    setBenchmarks((b) => b ? { ...b, refreshing: true } : null)
    setBmResult(null)
    try {
      const res = await fetch('/api/fetch/benchmarks', { method: 'POST' })
      const data = await res.json()
      setBmResult({ success: data.success, error: data.error })
      if (data.success) onDataUpdated()
    } catch {
      setBmResult({ success: false, error: 'Request failed' })
    }
    await fetchStatus()
  }

  const refreshBenchmarkSource = async (source: string) => {
    setRefreshingBmSource((s) => ({ ...s, [source]: true }))
    setBmSourceResults((r) => ({ ...r, [source]: { success: false } }))
    try {
      const res = await fetch(`/api/fetch/benchmarks/${source}`, { method: 'POST' })
      const data = await res.json()
      setBmSourceResults((r) => ({ ...r, [source]: { success: data.success, error: data.error } }))
      if (data.success) onDataUpdated()
    } catch {
      setBmSourceResults((r) => ({ ...r, [source]: { success: false, error: 'Request failed' } }))
    }
    setRefreshingBmSource((s) => ({ ...s, [source]: false }))
    await fetchStatus()
  }

  const refreshAll = async () => {
    setRefreshingAll(true)
    setResults({})
    try {
      const res = await fetch('/api/fetch', { method: 'POST' })
      const data = await res.json()
      const resultMap: Record<string, { success: boolean; error?: string }> = {}
      for (const r of data.results ?? []) {
        resultMap[r.provider] = { success: r.success, error: r.error }
      }
      setResults(resultMap)
      onDataUpdated()
    } catch {
      setError('Refresh all failed')
    }
    setRefreshingAll(false)
    await fetchStatus()
  }

  const scriptCount = providers.filter((p) => p.hasScript).length

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Data Management</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {!serverAvailable && (
          <div className="server-warning">
            <strong>Management server offline.</strong> Run <code>node server.js</code> in the project root to enable live updates.
          </div>
        )}

        {loading && <div className="panel-loading">Loading status…</div>}

        {!loading && serverAvailable && (
          <>
            <div className="panel-actions">
              <button
                className="btn-refresh-all"
                onClick={refreshAll}
                disabled={refreshingAll || scriptCount === 0}
              >
                {refreshingAll ? '⟳ Refreshing all…' : `⟳ Refresh all (${scriptCount} providers)`}
              </button>
            </div>

            <table className="management-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Models</th>
                  <th>Last updated</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => {
                  const result = results[p.name]
                  const isRefreshing = p.refreshing || refreshingAll
                  return (
                    <tr key={p.name}>
                      <td className="mgmt-provider">{p.name}</td>
                      <td className="mgmt-count">{p.modelCount}</td>
                      <td className="mgmt-age">{formatAge(p.lastUpdated)}</td>
                      <td className="mgmt-status">
                        {result ? (
                          result.success ? (
                            <span className="badge-ok">✓ updated</span>
                          ) : (
                            <span className="badge-err" title={result.error}>✗ failed</span>
                          )
                        ) : (
                          <span className={`badge-script ${p.hasScript ? 'has-script' : 'manual'}`}>
                            {p.hasScript ? 'auto' : 'manual'}
                          </span>
                        )}
                      </td>
                      <td>
                        {p.hasScript && (
                          <button
                            className="btn-refresh"
                            onClick={() => refreshProvider(p.key, p.name)}
                            disabled={isRefreshing}
                          >
                            {isRefreshing ? '⟳' : '↻'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {benchmarks && (
              <>
                <h3 className="mgmt-section-heading">Benchmark Data</h3>
                <table className="management-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Entries</th>
                      <th>Last updated</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* All-sources row */}
                    <tr>
                      <td className="mgmt-provider">All sources</td>
                      <td className="mgmt-count">{benchmarks.entryCount.toLocaleString()}</td>
                      <td className="mgmt-age">{formatAge(benchmarks.lastUpdated)}</td>
                      <td className="mgmt-status">
                        {bmResult ? (
                          bmResult.success ? (
                            <span className="badge-ok">✓ updated</span>
                          ) : (
                            <span className="badge-err" title={bmResult.error}>✗ failed</span>
                          )
                        ) : (
                          <span className="badge-script has-script">auto</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="btn-refresh"
                          onClick={refreshBenchmarks}
                          disabled={benchmarks.refreshing}
                        >
                          {benchmarks.refreshing ? '⟳' : '↻'}
                        </button>
                      </td>
                    </tr>
                    {/* Per-source rows */}
                    {(benchmarks.sources ?? []).map((src) => {
                      const result = bmSourceResults[src.key]
                      const isRefreshing = src.refreshing || refreshingBmSource[src.key]
                      return (
                        <tr key={src.key}>
                          <td className="mgmt-provider mgmt-source-indent">
                            {BENCHMARK_SOURCE_NAMES[src.key] ?? src.key}
                          </td>
                          <td className="mgmt-count"></td>
                          <td className="mgmt-age"></td>
                          <td className="mgmt-status">
                            {result ? (
                              result.success ? (
                                <span className="badge-ok">✓ updated</span>
                              ) : (
                                <span className="badge-err" title={result.error}>✗ failed</span>
                              )
                            ) : null}
                          </td>
                          <td>
                            <button
                              className="btn-refresh"
                              onClick={() => refreshBenchmarkSource(src.key)}
                              disabled={isRefreshing}
                            >
                              {isRefreshing ? '⟳' : '↻'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {error && !loading && <div className="panel-error">{error}</div>}
      </div>
    </div>
  )
}
