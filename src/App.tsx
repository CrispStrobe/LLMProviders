import { useState, useMemo, useCallback } from 'react'
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
  price_per_1m_tokens_30d?: number
  currency: string
  capabilities?: string[]
  display_name?: string
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
}

const normalizeName = (s: string) =>
  s.toLowerCase().replace(/[-_.]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const EXCHANGE_RATE_EUR_TO_USD = 1.05

const CAP_ICON: Record<string, string> = {
  vision: '👁',
  video: '🎬',
  audio: '🎤',
  'audio-out': '🔊',
  files: '📄',
  'image-gen': '🎨',
  tools: '🔧',
  reasoning: '💡',
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

  // Build benchmark lookup maps
  const { nameMap, hfIdMap } = useMemo(() => {
    const nameMap = new Map<string, BenchmarkEntry>();
    const hfIdMap = new Map<string, BenchmarkEntry>();

    for (const b of benchmarksData as BenchmarkEntry[]) {
      // Name-based lookup (LLMStats names + HF model part)
      nameMap.set(normalizeName(b.name), b);
      if (b.slug) {
        const slugModel = b.slug.split('/').pop() || '';
        if (slugModel) nameMap.set(normalizeName(slugModel), b);
      }
      if (b.hf_id) {
        // Full HF ID lookup (for direct matches from OpenRouter/Requesty)
        hfIdMap.set(normalizeName(b.hf_id), b);
        // Model part only (after "/")
        const modelPart = b.hf_id.split('/').pop() || '';
        const normModel = normalizeName(modelPart);
        nameMap.set(normModel, b);
        // Strip leading word from model part (removes embedded org prefix like "Meta-Llama-...")
        const words = normModel.split(' ');
        if (words.length > 1) nameMap.set(words.slice(1).join(' '), b);
      }
      // LiveBench model name (e.g. "claude-3-5-sonnet-20241022")
      if (b.lb_name) nameMap.set(normalizeName(b.lb_name), b);
      // Chatbot Arena display name
      if (b.arena_name) nameMap.set(normalizeName(b.arena_name), b);
    }
    return { nameMap, hfIdMap };
  }, []);

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

  const getComplianceStatus = (provider: Provider) => {
    const hq = provider.headquarters.toLowerCase();
    const isEU = provider.region === 'EU' || hq === 'germany' || hq === 'france' || hq === 'netherlands';
    const isUS = hq === 'usa';
    const isEEA = provider.region === 'EEA Equivalent' || hq === 'switzerland';

    if (isEU) return 'EU (Sovereign)';
    if (isEEA) return 'Non-EU (EEA/Swiss)';
    if (isUS && provider.eu_endpoints) return 'US (EU Endpoint / Cloud Act)';
    if (isUS) return 'US (Global / Cloud Act)';
    return 'Other Non-EU';
  };

  const allModels = useMemo(() => {
    const rawModels: (Model & { provider: Provider; complianceStatus: string })[] = []
    
    providersData.providers.forEach((provider: Provider) => {
      const status = getComplianceStatus(provider);
      provider.models.forEach((model) => {
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
      const key = `${m.provider.name}|${m.name}|${m.input_price_per_1m}|${m.output_price_per_1m}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return uniqueModels;
  }, [])

  const filteredModels = useMemo(() => {
    return allModels.filter((model) => {
      const matchesSearch = model.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                           model.provider.name.toLowerCase().includes(searchTerm.toLowerCase())
      const matchesType = selectedType === 'all' || model.type === selectedType
      const matchesRegion = selectedRegion === 'all' || model.complianceStatus.includes(selectedRegion)
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
        case 'aider_pass_rate': {
          const bA = findBenchmark(a.name);
          const bB = findBenchmark(b.name);
          aValue = bA?.[sortConfig.key as keyof BenchmarkEntry] as number ?? -1;
          bValue = bB?.[sortConfig.key as keyof BenchmarkEntry] as number ?? -1;
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
      const name = m.name.toLowerCase();
      if (!groups[name]) groups[name] = [];
      groups[name].push(m);
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
              <span className="data-stale-hint" title="Data was refreshed — reload the page to see updated prices">
                ↻ data updated
              </span>
            )}
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
          <option value="Non-EU">Non-EU (Swiss/EEA)</option>
          <option value="US">US (Cloud Act)</option>
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
              const isGroupStart = groupByModel && (idx === 0 || displayModels[idx-1].name.toLowerCase() !== model.name.toLowerCase());
              return (
                <tr key={`${model.provider.name}-${model.name}-${idx}`} className={isGroupStart ? 'group-divider' : ''}>
                  <td className="provider-cell">{model.provider.name}</td>
                  <td>
                    <span className={`status-badge ${model.complianceStatus.replace(/\s+|[\(\)\/]/g, '-').toLowerCase()}`}>
                      {model.complianceStatus}
                    </span>
                  </td>
                  <td className="model-name">{model.display_name ?? model.name}</td>
                  <td className="caps-cell">
                    {(model.capabilities || []).map(cap => (
                      <span key={cap} className={`cap-badge cap-${cap}`} title={cap}>{CAP_ICON[cap] ?? cap}</span>
                    ))}
                  </td>
                  <td className="size-cell">{model.size_b ? `${model.size_b}B` : '-'}</td>
                  <td>
                    {model.price_per_image !== undefined && !model.input_price_per_1m
                      ? `$${model.price_per_image}/MP`
                      : formatPrice(model.input_price_per_1m, model.currency)}
                  </td>
                  <td>
                    {model.price_per_image !== undefined && !model.output_price_per_1m
                      ? '–'
                      : formatPrice(model.output_price_per_1m, model.currency)}
                  </td>
                  {showBenchmarks && (() => {
                    const bm = findBenchmark(model.name);
                    const fmt = (v?: number) => Number.isFinite(v) ? `${(v! * 100).toFixed(0)}%` : '–';
                    return <>
                      <td className="benchmark-cell">{bm?.arena_elo !== undefined ? Math.round(bm.arena_elo) : '–'}</td>
                      <td className="benchmark-cell">{fmt(bm?.aider_pass_rate)}</td>
                      <td className="benchmark-cell">{fmt(bm?.lb_global)}</td>
                      <td className="benchmark-cell">{fmt(bm?.lb_math)}</td>
                      <td className="benchmark-cell">{fmt(bm?.lb_coding)}</td>
                      <td className="benchmark-cell">{fmt(bm?.lb_reasoning)}</td>
                      <td className="benchmark-cell">{fmt(bm?.gpqa)}</td>
                      <td className="benchmark-cell">{fmt(bm?.mmlu_pro)}</td>
                      <td className="benchmark-cell">{fmt(bm?.ifeval)}</td>
                      <td className="benchmark-cell">{fmt(bm?.bbh)}</td>
                      <td className="benchmark-cell">{fmt(bm?.hf_math_lvl5)}</td>
                      <td className="benchmark-cell">{fmt(bm?.hf_musr)}</td>
                      <td className="benchmark-cell">{fmt(bm?.mmlu)}</td>
                      <td className="benchmark-cell">{fmt(bm?.human_eval)}</td>
                    </>;
                  })()}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      
      <footer>
        <p>* All prices normalized to USD for comparison using 1 EUR = {EXCHANGE_RATE_EUR_TO_USD} USD.</p>
        <p>Sorted by input price by default.</p>
      </footer>
    </div>
  )
}

export default App
