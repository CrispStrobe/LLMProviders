import { useState, useMemo, useCallback, useEffect } from 'react'
import providersData from '../data/providers.json'
import benchmarksData from '../data/benchmarks.json'
import { ManagementPanel } from './components/ManagementPanel'

interface Model {
  name: string
  category?: string
  type: string
  size_b?: number
  input_price_per_1m?: number
  output_price_per_1m?: number
  price_per_image?: number
  price_per_minute?: number
  audio_price_per_1m?: number
  price_per_1m_tokens_30d?: number
  currency: string
  capabilities?: string[]
  display_name?: string
  hf_id?: string
  ollama_id?: string
  hf_private?: boolean;
  size_source?: 'hf-total' | 'hf-config-estimate' | 'hf-card' | 'ollama' | 'manual' | 'benchmark' | 'openrouter';
  provider?: Provider;
  complianceStatus?: string;
}

interface Provider {
  name: string
  url: string
  headquarters: string
  region: string
  gdpr_compliant: boolean
  eu_endpoints: boolean
  models: Model[]
}

type SortConfig = {
  key: string;
  direction: 'asc' | 'desc';
} | null;

interface BenchmarkEntry {
  slug?: string;   // LLMStats slug
  hf_id?: string;  // HF leaderboard fullname
  name: string;
  // LLMStats benchmarks
  mmlu?: number;
  mmlu_pro?: number;
  gpqa?: number;
  human_eval?: number;
  math?: number;
  gsm8k?: number;
  mmmu?: number;
  hellaswag?: number;
  ifeval?: number;
  arc?: number;
  drop?: number;
  mbpp?: number;
  mgsm?: number;
  bbh?: number;
  // HF-specific
  hf_math_lvl5?: number;
  hf_musr?: number;
  hf_avg?: number;
  params_b?: number;
  // LiveBench (livebench.ai — contamination-free, monthly updated)
  lb_name?: string;
  lb_global?: number;
  lb_reasoning?: number;
  lb_coding?: number;
  lb_math?: number;
  lb_language?: number;
  lb_if?: number;
  lb_data_analysis?: number;
  // Chatbot Arena (lmarena.ai — real human preference votes)
  arena_name?: string;
  arena_elo?: number;   // raw ELO score ~800-1500 (higher = better)
  arena_rank?: number;
  arena_votes?: number;
  // Aider code editing benchmark (aider.chat)
  aider_pass_rate?: number; // 0-1, first-pass success on 133 coding tasks
  // Artificial Analysis (artificialanalysis.ai)
  aa_id?: string;
  aa_name?: string;
  aa_slug?: string;
  aa_intelligence?: number; // 0-100 intelligence index
  aa_coding?: number;       // 0-100 coding index
  aa_math?: number;         // 0-100 math index
  aa_mmlu_pro?: number;
  aa_gpqa?: number;
  aa_livecodebench?: number;
  aa_hle?: number;
  aa_scicode?: number;
  aa_math_500?: number;
  aa_aime?: number;
  aa_tokens_per_s?: number;
  aa_latency_s?: number;
  // MTEB (Massive Text Embedding Benchmark)
  mteb_avg?: number;
  mteb_retrieval?: number;
  // OCR Benchmark
  ocr_avg?: number;
}

const normalizeName = (s?: string) =>
  (s || '').toLowerCase().replace(/[-_.]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const EXCHANGE_RATE_EUR_TO_USD = 1.05

const CAP_ICON: Record<string, string> = {
  // Input Modalities
  vision: '👁',      // Image Input
  video: '🎬',       // Video Input
  audio: '🎤',       // Audio Input (ASR)
  files: '📄',       // File/PDF Input
  
  // Output Modalities
  'image-out': '🎨', // Image Generation
  'video-out': '🎥', // Video Generation
  'audio-out': '🔊', // Audio Generation (TTS)
  
  // Functional Capabilities
  tools: '🔧',
  reasoning: '💡',
  embedding: '🧩',
  'eu-endpoint': '🇪🇺',
}

function App() {
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedType, setSelectedType] = useState('all')
  const [selectedRegion, setSelectedRegion] = useState('all')
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'price', direction: 'asc' });
  const [groupByModel, setGroupByModel] = useState(false);
  const [showBenchmarks, setShowBenchmarks] = useState(false);
  const [showManagement, setShowManagement] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

  // Live data — initialized from bundled JSON, refreshed from /api/* when available
  const [liveProviders, setLiveProviders] = useState<Provider[]>((providersData as any).providers);
  const [liveBenchmarks, setLiveBenchmarks] = useState<BenchmarkEntry[]>(benchmarksData as BenchmarkEntry[]);

  useEffect(() => {
    fetch('/api/data')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.providers) setLiveProviders(d.providers); })
      .catch(() => {});
    fetch('/api/benchmarks')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) setLiveBenchmarks(d); })
      .catch(() => {});
  }, [dataVersion]);

  const fmtNum = (v?: number, decimals = 0) => (v !== undefined && Number.isFinite(v)) ? v.toFixed(decimals) : '–';
  const fmtPct = (v?: number) => (v !== undefined && Number.isFinite(v)) ? `${(v * 100).toFixed(0)}%` : '–';

  // Build benchmark lookup maps
  const { nameMap, hfIdMap } = useMemo(() => {
    const nameMap = new Map<string, BenchmarkEntry>();
    const hfIdMap = new Map<string, BenchmarkEntry>();

    for (const b of liveBenchmarks) {
      nameMap.set(normalizeName(b.name), b);
      if (b.slug) {
        const slugModel = b.slug.split('/').pop() || '';
        if (slugModel) nameMap.set(normalizeName(slugModel), b);
      }
      if (b.hf_id) {
        hfIdMap.set(normalizeName(b.hf_id), b);
        const modelPart = b.hf_id.split('/').pop() || '';
        const normModel = normalizeName(modelPart);
        nameMap.set(normModel, b);
        const words = normModel.split(' ');
        if (words.length > 1) nameMap.set(words.slice(1).join(' '), b);
      }
      if (b.lb_name) nameMap.set(normalizeName(b.lb_name), b);
      if (b.arena_name) nameMap.set(normalizeName(b.arena_name), b);
      if (b.aa_name) nameMap.set(normalizeName(b.aa_name), b);
      if (b.aa_slug) nameMap.set(normalizeName(b.aa_slug), b);
    }
    return { nameMap, hfIdMap };
  }, [liveBenchmarks]);

  const findBenchmark = useCallback((modelName: string): BenchmarkEntry | undefined => {
    // Strip @region (e.g. @us-east-1) and :effort (e.g. :high) suffixes before normalizing
    const cleanName = modelName.replace(/@[^/]+$/, '').replace(/:[^/]+$/, '');
    const norm = normalizeName(cleanName);

    // Direct HF ID match (for providers that use "org/model-id" format)
    let modelPart = '';
    if (cleanName.includes('/')) {
      if (hfIdMap.has(norm)) return hfIdMap.get(norm)!;
      // Try model part only (after "/")
      modelPart = normalizeName(cleanName.split('/').pop() || '');
      if (nameMap.has(modelPart)) return nameMap.get(modelPart)!;
      // Strip first word from model part — handles "Meta-Llama-..." vs "Llama-..."
      const modelWords = modelPart.split(' ');
      if (modelWords.length > 1) {
        const stripped = modelWords.slice(1).join(' ');
        if (nameMap.has(stripped)) return nameMap.get(stripped)!;
      }
    }

    if (nameMap.has(norm)) return nameMap.get(norm);

    // Longest startsWith match — handles date-suffixed variants like "claude-3-5-sonnet-20241022"
    let best: BenchmarkEntry | undefined;
    let bestLen = 0;
    for (const [key, val] of nameMap) {
      if (norm.startsWith(key)) {
        const rest = norm.slice(key.length);
        if ((rest === '' || /^ \d/.test(rest)) && key.length > bestLen) {
          best = val;
          bestLen = key.length;
        }
      }
    }
    if (best) return best;

    // Reverse prefix: benchmark key starts with provider name — handles cases where the
    // benchmark stores a base name longer than the provider's model ID.
    // Check both norm and modelPart (for versionless names like "anthropic/claude-haiku-4-5").
    // Pick the highest lb_global among all matches (best variant of the model).
    let bestReverse: BenchmarkEntry | undefined;
    let bestReverseScore = -1;
    for (const [key, val] of nameMap) {
      const score = val.lb_global ?? 0;
      if (
        (key.startsWith(norm + ' ') || (modelPart && key.startsWith(modelPart + ' '))) &&
        score > bestReverseScore
      ) {
        bestReverse = val;
        bestReverseScore = score;
      }
    }
    return bestReverse;
  }, [nameMap, hfIdMap]);

  const handleDataUpdated = useCallback(() => {
    // Increment version to signal that a page reload would show fresh data
    setDataVersion((v) => v + 1);
  }, []);

  const getComplianceStatus = (provider: Provider, model?: Model) => {
    const hq = provider.headquarters.toLowerCase();
    const isEU = provider.region === 'EU' || hq === 'germany' || hq === 'france' || hq === 'netherlands';
    const isUS = hq === 'usa' || provider.region === 'US';
    const isEEA = provider.region === 'EEA Equivalent' || hq === 'switzerland';

    // Model-level override for OpenRouter or similar aggregators
    const hasEuEndpoint = model?.capabilities?.includes('eu-endpoint') || provider.eu_endpoints;

    if (isEU) return 'EU';
    if (isEEA) return 'EEA';
    if (isUS && hasEuEndpoint) return 'US/EU';
    if (isUS) return 'US';
    return 'Other';
  };

  const allModels = useMemo(() => {
    const rawModels: any[] = []
    
    liveProviders.forEach((provider: Provider) => {
      provider.models.forEach((model) => {
        const status = getComplianceStatus(provider, model);
        let cleanName = model.name;
        // Strip provider/ prefix for all models
        if (cleanName.includes('/')) {
          cleanName = cleanName.split('/').pop() || cleanName;
        }

        rawModels.push({ 
          ...model, 
          name: cleanName,
          provider, 
          complianceStatus: status 
        })
      })
    })

    // De-duplicate: filter out models with same name, provider, and price
    const seen = new Set<string>();
    const uniqueModels = rawModels.filter(m => {
      const key = `${m.provider?.name}|${m.name}|${m.input_price_per_1m}|${m.output_price_per_1m}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return uniqueModels;
  }, [liveProviders])

  const filteredModels = useMemo(() => {
    return allModels.filter((model) => {
      const providerName = model.provider?.name || '';
      const matchesSearch = model.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                           providerName.toLowerCase().includes(searchTerm.toLowerCase())
      
      const caps = model.capabilities || [];
      const matchesType = selectedType === 'all' || 
                         model.type === selectedType ||
                         (selectedType === 'audio' && (caps.includes('audio') || caps.includes('audio-out'))) ||
                         (selectedType === 'vision' && (caps.includes('vision') || caps.includes('video'))) ||
                         (selectedType === 'chat' && model.type === 'chat');
      
      const status = model.complianceStatus || 'Other';
      let matchesRegion = selectedRegion === 'all' || status === selectedRegion;
      // US filter includes US/EU
      if (selectedRegion === 'US' && status === 'US/EU') matchesRegion = true;
      
      return matchesSearch && matchesType && matchesRegion
    })
  }, [searchTerm, selectedType, selectedRegion, allModels])

  const getNormalizedPriceUSD = (model: Model) => {
    const price = model.input_price_per_1m || model.price_per_image || model.price_per_minute || 0
    return model.currency === 'EUR' ? price * EXCHANGE_RATE_EUR_TO_USD : price
  }

  const sortedModels = useMemo(() => {
    return [...filteredModels].sort((a, b) => {
      if (!sortConfig) return 0;
      let aValue: any;
      let bValue: any;

      switch (sortConfig.key) {
        case 'provider':
          aValue = a.provider.name;
          bValue = b.provider.name;
          break;
        case 'model':
          aValue = a.name;
          bValue = b.name;
          break;
        case 'size':
          aValue = a.size_b || 0;
          bValue = b.size_b || 0;
          break;
        case 'price':
          aValue = getNormalizedPriceUSD(a);
          bValue = getNormalizedPriceUSD(b);
          break;
        case 'output_price':
          aValue = a.output_price_per_1m ?? 0;
          bValue = b.output_price_per_1m ?? 0;
          break;
        case 'compliance':
          aValue = a.complianceStatus;
          bValue = b.complianceStatus;
          break;
        case 'mmlu':
        case 'gpqa':
        case 'human_eval':
        case 'math':
        case 'gsm8k':
        case 'mmmu':
        case 'ifeval':
        case 'bbh':
        case 'hf_math_lvl5':
        case 'hf_musr':
        case 'hf_avg':
        case 'lb_global':
        case 'lb_reasoning':
        case 'lb_coding':
        case 'lb_math':
        case 'lb_language':
        case 'lb_if':
        case 'lb_data_analysis':
        case 'arena_elo':
        case 'aider_pass_rate':
        case 'aa_intelligence':
        case 'aa_tokens_per_s':
        case 'mteb_avg':
        case 'mteb_retrieval': {
          try {
            const bA = findBenchmark(a.name);
            const bB = findBenchmark(b.name);
            aValue = bA?.[sortConfig.key as keyof BenchmarkEntry] as number ?? -1;
            bValue = bB?.[sortConfig.key as keyof BenchmarkEntry] as number ?? -1;
          } catch (e) {
            aValue = -1;
            bValue = -1;
          }
          break;
        }
        default:
          return 0;
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredModels, sortConfig])

  const displayModels = useMemo(() => {
    if (!groupByModel) return sortedModels;

    const groups: Record<string, typeof sortedModels> = {};
    sortedModels.forEach(m => {
      // Prioritize hf_id for grouping key
      const key = (m.hf_id || m.name || '').toLowerCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    });

    const result: typeof sortedModels = [];
    Object.values(groups).forEach(group => {
      result.push(...group);
    });
    return result;
  }, [sortedModels, groupByModel]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const formatPrice = (price: number | undefined, currency: string) => {
    if (price === undefined) return '-'
    if (price === 0) return 'Free'
    const symbol = currency === 'USD' ? '$' : '€'
    return `${symbol}${price.toFixed(4)}`
  }

  const getSortIcon = (key: string) => {
    if (sortConfig?.key !== key) return '↕️';
    return sortConfig.direction === 'asc' ? '🔼' : '🔽';
  }

  return (
    <div className="container">
      <header>
        <div className="header-row">
          <div>
            <h1>AI Provider Comparison</h1>
            <p>Analyze costs, data sovereignty, and model efficiency.</p>
          </div>
          <div className="header-actions">
            {dataVersion > 0 && (
              <span className="data-stale-hint" title="Data refreshed from server">
                ↻ data updated
              </span>
            )}
            <a
              className="btn-github"
              href="https://github.com/CrispStrobe/LLMProviders"
              target="_blank"
              rel="noopener noreferrer"
              title="View source on GitHub"
            >
              GitHub
            </a>
            <button className="btn-manage" onClick={() => setShowManagement(true)}>
              ⚙ Manage Data
            </button>
          </div>
        </div>
      </header>

      {showManagement && (
        <ManagementPanel
          onClose={() => setShowManagement(false)}
          onDataUpdated={handleDataUpdated}
        />
      )}

      <div className="controls">
        <input 
          type="text" 
          placeholder="Search models or providers..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
        <select value={selectedType} onChange={(e) => setSelectedType(e.target.value)} className="type-select">
          <option value="all">All Types</option>
          <option value="chat">Chat (LLM)</option>
          <option value="vision">Vision</option>
          <option value="embedding">Embedding</option>
          <option value="image">Image</option>
          <option value="audio">Audio</option>
        </select>
        <select value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)} className="type-select">
          <option value="all">All Jurisdictions</option>
          <option value="EU">EU (Sovereign)</option>
          <option value="EEA">EEA (Swiss/EEA)</option>
          <option value="US/EU">US/EU (EU Endpoint)</option>
          <option value="US">US (Cloud Act)</option>
          <option value="Other">Other</option>
        </select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={groupByModel}
            onChange={(e) => setGroupByModel(e.target.checked)}
          />
          Group by Model
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showBenchmarks}
            onChange={(e) => setShowBenchmarks(e.target.checked)}
          />
          Show Benchmarks
        </label>
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th onClick={() => requestSort('provider')} className="sortable">Provider {getSortIcon('provider')}</th>
              <th onClick={() => requestSort('compliance')} className="sortable">Jurisdiction {getSortIcon('compliance')}</th>
              <th onClick={() => requestSort('model')} className="sortable">Model {getSortIcon('model')}</th>
              <th>Caps</th>
              <th onClick={() => requestSort('size')} className="sortable">Size (B) {getSortIcon('size')}</th>
              <th onClick={() => requestSort('price')} className="sortable">Input Price (USD) {getSortIcon('price')}</th>
              <th onClick={() => requestSort('output_price')} className="sortable">Output Price {getSortIcon('output_price')}</th>
              {showBenchmarks && <>
                <th onClick={() => requestSort('arena_elo')} className="sortable" title="Chatbot Arena ELO (human preference votes)">Arena ELO {getSortIcon('arena_elo')}</th>
                <th onClick={() => requestSort('aider_pass_rate')} className="sortable" title="Aider code editing benchmark (pass rate, 133 tasks)">Aider {getSortIcon('aider_pass_rate')}</th>
                <th onClick={() => requestSort('aa_intelligence')} className="sortable" title="Artificial Analysis Intelligence Index (0-100)">AA Intel {getSortIcon('aa_intelligence')}</th>
                <th onClick={() => requestSort('aa_tokens_per_s')} className="sortable" title="Artificial Analysis Median Speed (Tokens per Second)">AA Speed {getSortIcon('aa_tokens_per_s')}</th>
                <th onClick={() => requestSort('mteb_avg')} className="sortable" title="MTEB (Massive Text Embedding Benchmark) Average">MTEB {getSortIcon('mteb_avg')}</th>
                <th onClick={() => requestSort('mteb_retrieval')} className="sortable" title="MTEB Retrieval Average">MTEB-Ret {getSortIcon('mteb_retrieval')}</th>
                <th onClick={() => requestSort('lb_global')} className="sortable" title="LiveBench overall average (contamination-free)">LB {getSortIcon('lb_global')}</th>
                <th onClick={() => requestSort('lb_math')} className="sortable" title="LiveBench Mathematics">LB-Math {getSortIcon('lb_math')}</th>
                <th onClick={() => requestSort('lb_coding')} className="sortable" title="LiveBench Coding + Agentic Coding">LB-Code {getSortIcon('lb_coding')}</th>
                <th onClick={() => requestSort('lb_reasoning')} className="sortable" title="LiveBench Reasoning">LB-Reas {getSortIcon('lb_reasoning')}</th>
                <th onClick={() => requestSort('gpqa')} className="sortable" title="Graduate-level reasoning (GPQA)">GPQA {getSortIcon('gpqa')}</th>
                <th onClick={() => requestSort('mmlu_pro')} className="sortable" title="MMLU-Pro knowledge">MMLU-PRO {getSortIcon('mmlu_pro')}</th>
                <th onClick={() => requestSort('ifeval')} className="sortable" title="Instruction following (IFEval)">IFEval {getSortIcon('ifeval')}</th>
                <th onClick={() => requestSort('bbh')} className="sortable" title="Big-Bench Hard reasoning">BBH {getSortIcon('bbh')}</th>
                <th onClick={() => requestSort('hf_math_lvl5')} className="sortable" title="MATH Level 5 (HF leaderboard)">MATH L5 {getSortIcon('hf_math_lvl5')}</th>
                <th onClick={() => requestSort('hf_musr')} className="sortable" title="Multi-step Soft Reasoning (HF leaderboard)">MUSR {getSortIcon('hf_musr')}</th>
                <th onClick={() => requestSort('mmlu')} className="sortable" title="Classic MMLU (LLMStats)">MMLU {getSortIcon('mmlu')}</th>
                <th onClick={() => requestSort('human_eval')} className="sortable" title="HumanEval coding (LLMStats)">HumanEval {getSortIcon('human_eval')}</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {displayModels.map((model, idx) => {
              const prev = displayModels[idx - 1];
              const isGroupStart = groupByModel && (
                idx === 0 || 
                (prev.hf_id?.toLowerCase() !== model.hf_id?.toLowerCase()) ||
                (!model.hf_id && prev.name.toLowerCase() !== model.name.toLowerCase())
              );
              const bm = findBenchmark(model.name);
              return (
                <tr key={`${model.provider.name}-${model.name}-${idx}`} className={isGroupStart ? 'group-divider' : ''}>
                  <td className="provider-cell">{model.provider.name}</td>
                  <td>
                    <span className={`status-badge ${model.complianceStatus.replace(/\s+|[\(\)\/]/g, '-').toLowerCase()}`}>
                      {model.complianceStatus}
                    </span>
                  </td>
                  <td className="model-name">
                    <div className="model-name-wrapper">
                      {model.display_name ?? model.name}
                      <div className="model-info-container">
                        <span className="info-icon">ⓘ</span>
                        <div className="model-tooltip">
                          <div className="tooltip-row"><strong>Type:</strong> {model.type}</div>
                          {model.size_b && <div className="tooltip-row"><strong>Size:</strong> {model.size_b}B</div>}
                          {model.hf_id && (
                            <div className="tooltip-row">
                              <strong>HF:</strong> 
                              <a href={`https://huggingface.co/${model.hf_id}`} target="_blank" rel="noopener noreferrer" className="hf-link">
                                {model.hf_id} ↗
                              </a>
                            </div>
                          )}
                          {!model.hf_id && model.hf_private && (
                            <div className="tooltip-row"><strong>HF:</strong> Proprietary API</div>
                          )}
                          {model.ollama_id && (
                            <div className="tooltip-row">
                              <strong>Ollama:</strong> 
                              <a href={`https://ollama.com/library/${model.ollama_id}`} target="_blank" rel="noopener noreferrer" className="hf-link">
                                {model.ollama_id} ↗
                              </a>
                            </div>
                          )}
                          {model.capabilities && model.capabilities.length > 0 && (
                            <div className="tooltip-row"><strong>Caps:</strong> {model.capabilities.join(', ')}</div>
                          )}
                          {bm?.ocr_avg !== undefined && (
                            <div className="tooltip-row"><strong>OCR:</strong> {bm.ocr_avg.toFixed(1)} (Benchmark)</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="caps-cell">
                    {model.type === 'embedding' && (
                      <span className="cap-badge cap-embedding" title="embedding">{CAP_ICON.embedding}</span>
                    )}
                    {(model.capabilities || []).map((cap: string) => (
                      <span key={cap} className={`cap-badge cap-${cap}`} title={cap}>{CAP_ICON[cap] ?? cap}</span>
                    ))}
                  </td>
                  <td className="size-cell">{model.size_b ? `${model.size_b}B` : '-'}</td>
                  <td>
                    <div className="price-stack">
                      {model.price_per_image !== undefined && !model.input_price_per_1m
                        ? `$${model.price_per_image}/MP`
                        : model.price_per_minute !== undefined
                        ? `${formatPrice(model.price_per_minute, model.currency)}/min`
                        : formatPrice(model.input_price_per_1m, model.currency)}
                      {model.audio_price_per_1m !== undefined && (
                        <div className="price-subtext" title="Audio token price">
                          {CAP_ICON.audio} {formatPrice(model.audio_price_per_1m, model.currency)}/M
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    {model.price_per_image !== undefined && !model.output_price_per_1m
                      ? '–'
                      : model.price_per_minute !== undefined
                      ? '–'
                      : formatPrice(model.output_price_per_1m, model.currency)}
                  </td>
                  {showBenchmarks && (
                    <>
                      <td className="benchmark-cell">{fmtNum(bm?.arena_elo)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.aider_pass_rate)}</td>
                      <td className="benchmark-cell">{fmtNum(bm?.aa_intelligence)}</td>
                      <td className="benchmark-cell">{fmtNum(bm?.aa_tokens_per_s)}</td>
                      <td className="benchmark-cell">{fmtNum(bm?.mteb_avg, 1)}</td>
                      <td className="benchmark-cell">{fmtNum(bm?.mteb_retrieval, 1)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.lb_global)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.lb_math)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.lb_coding)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.lb_reasoning)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.gpqa)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.mmlu_pro)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.ifeval)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.bbh)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.hf_math_lvl5)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.hf_musr)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.mmlu)}</td>
                      <td className="benchmark-cell">{fmtPct(bm?.human_eval)}</td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      
      <footer>
        <p>* All prices normalized to USD for comparison using 1 EUR = {EXCHANGE_RATE_EUR_TO_USD} USD.</p>
        <p>Benchmark data from LLMStats, HF Leaderboard, LiveBench, Chatbot Arena, Aider, MTEB, and <a href="https://artificialanalysis.ai/" target="_blank" rel="noopener noreferrer">Artificial Analysis</a>.</p>
        <p>Sorted by input price by default.</p>
      </footer>
    </div>
  )
}

export default App
