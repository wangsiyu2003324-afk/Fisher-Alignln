
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Activity, 
  Shield, 
  ShieldAlert, 
  Users, 
  Zap, 
  BarChart3, 
  Play, 
  RotateCcw,
  Settings,
  Database
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis
} from 'recharts';

// --- Types & Constants ---

type ClientType = 'benign' | 'malicious';

interface Client {
  id: number;
  type: ClientType;
  gradient: number[]; // Simplified high-dim vector
  dataDistribution: number; // For Non-IID simulation (0-1)
  stiffnessViolationScore: number;
  isAccepted: boolean;
}

interface SimulationState {
  round: number;
  globalAccuracy: number;
  backdoorSuccessRate: number;
  globalFIM: number[]; // Momentum FIM
  clients: Client[];
  history: { round: number; acc: number; asr: number }[];
}

const VECTOR_DIM = 20; // Simulated parameter dimension
const NUM_CLIENTS = 20;
const MALICIOUS_RATIO = 0.2;

// --- Helper Math Functions ---

const randomNormal = () => {
  let u = 0, v = 0;
  while(u === 0) u = Math.random(); 
  while(v === 0) v = Math.random();
  return Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
};

// Simulate generating a gradient based on client type and data distribution
const generateGradient = (
  type: ClientType, 
  distribution: number, 
  nonIIDLevel: number, 
  attackStrength: number,
  globalModelDirection: number[]
): number[] => {
  return Array.from({ length: VECTOR_DIM }, (_, i) => {
    // Base direction (Ground Truth)
    let val = globalModelDirection[i];
    
    // Add Non-IID noise
    // If Non-IID is high, the gradient deviates significantly based on 'distribution'
    const noise = randomNormal() * nonIIDLevel * 2;
    const bias = Math.sin(distribution * Math.PI * 2 + i) * nonIIDLevel;
    val += noise + bias;

    // Malicious modification (Backdoor injection)
    // Attackers try to pull specific parameters (e.g., indices 0-4) strongly in reverse
    if (type === 'malicious') {
      if (i < 5) { // Target specific "trigger" parameters
        val -= attackStrength * 5; 
      } else {
        // Stealth: try to mimic benign distribution on other params
        val += randomNormal() * 0.5;
      }
    }

    return val;
  });
};

// Calculate dot product
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

// Calculate magnitude
const mag = (a: number[]) => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));

// --- Main Application ---

const App = () => {
  // --- Simulation Config State ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [simSpeed, setSimSpeed] = useState(500);
  
  // Defense Toggles
  const [useMomentumFIM, setUseMomentumFIM] = useState(true);
  const [useStiffnessMask, setUseStiffnessMask] = useState(true);
  const [useLayerWeightedClustering, setUseLayerWeightedClustering] = useState(true);

  // Environment Config
  const [nonIIDLevel, setNonIIDLevel] = useState(0.5); // 0 = IID, 1 = Highly Non-IID
  const [attackStealth, setAttackStealth] = useState(0.6); // 1 = Very Stealthy (Low magnitude)

  // --- Simulation Runtime State ---
  const [state, setState] = useState<SimulationState>({
    round: 0,
    globalAccuracy: 0.1,
    backdoorSuccessRate: 0,
    globalFIM: Array(VECTOR_DIM).fill(1), // Init FIM
    clients: [],
    history: []
  });

  // Global Model Direction (Conceptually the "True" gradient direction)
  const trueGradientRef = useRef<number[]>(Array.from({ length: VECTOR_DIM }, () => randomNormal()));

  // --- Core Simulation Engine ---

  const runRound = () => {
    setState(prev => {
      const newRound = prev.round + 1;
      
      // 1. Generate Clients & Gradients
      const newClients: Client[] = Array.from({ length: NUM_CLIENTS }, (_, i) => {
        const type: ClientType = i < NUM_CLIENTS * MALICIOUS_RATIO ? 'malicious' : 'benign';
        const distribution = type === 'malicious' ? 0.9 : (i / NUM_CLIENTS); // Attackers often collude on similar data
        
        // Attack strength is inverse to stealth
        const strength = (1.5 - attackStealth); 
        
        return {
          id: i,
          type,
          dataDistribution: distribution,
          gradient: generateGradient(type, distribution, nonIIDLevel, strength, trueGradientRef.current),
          stiffnessViolationScore: 0,
          isAccepted: true // Default accept
        };
      });

      // 2. Defense Logic: FIM-Based Detection
      
      // Update Momentum FIM (Simulated)
      // In reality, we'd compute this from accepted gradients. Here we simulate the concept:
      // FIM is high for first 5 parameters (sensitive features) and random for others.
      // This represents "History" knowing which params are important.
      let currentFIM = prev.globalFIM;
      if (useMomentumFIM) {
        // Simulation: The "True" model relies heavily on indices 0-4. FIM should reflect this.
        const idealFIM = Array.from({length: VECTOR_DIM}, (_, i) => i < 5 ? 10.0 : 1.0);
        // EMA Update: F_new = 0.9 * F_old + 0.1 * F_current
        currentFIM = currentFIM.map((f, i) => 0.9 * f + 0.1 * idealFIM[i]);
      }

      // Calculate Scores & filter
      const acceptedGradients: number[][] = [];
      const processedClients = newClients.map(client => {
        let isMaliciousDetected = false;
        let stiffnessScore = 0;

        // Mechanism A: Stiffness Conflict (The "Mask" logic)
        if (useStiffnessMask) {
          // Calculate weighted alignment on High-FIM parameters
          // Score = Sum(FIM_i * |grad_i|) for params where grad direction is suspicious
          // Simplified: If FIM is high, gradient magnitude should be consistent with benign history.
          // Here, attackers modify indices 0-4 (High FIM).
          
          stiffnessScore = client.gradient.reduce((acc, val, idx) => {
            const importance = currentFIM[idx];
            // If importance is high, large changes are suspicious (Stiffness)
            return acc + (importance * Math.abs(val));
          }, 0);

          // Normalization for threshold
          stiffnessScore = stiffnessScore / VECTOR_DIM;
          
          // Dynamic Threshold based on benign cluster stats (simplified here)
          const threshold = (useMomentumFIM ? 12 : 15) * (1 + nonIIDLevel); 
          if (stiffnessScore > threshold) isMaliciousDetected = true;
        }

        // Mechanism B: Layer/FIM Weighted Clustering (Distance check)
        if (useLayerWeightedClustering && !isMaliciousDetected) {
           // Compute distance to "True" direction weighted by FIM
           // This reduces the impact of Non-IID noise (usually in Low-FIM areas)
           // and highlights Backdoor noise (in High-FIM areas)
           let dist = 0;
           for(let i=0; i<VECTOR_DIM; i++) {
             const weight = useLayerWeightedClustering ? currentFIM[i] : 1;
             const diff = client.gradient[i] - trueGradientRef.current[i];
             dist += weight * (diff * diff);
           }
           // Simple outlier detection
           if (dist > (500 * (1+nonIIDLevel))) isMaliciousDetected = true;
        }

        // Basic check for control group (without our defenses, simplistic clustering fails on Non-IID)
        if (!useStiffnessMask && !useLayerWeightedClustering) {
           // Simple Magnitude check (fails against stealth)
           if (mag(client.gradient) > 25) isMaliciousDetected = true;
        }

        return { ...client, stiffnessViolationScore: stiffnessScore, isAccepted: !isMaliciousDetected };
      });

      // 3. Aggregation & Metrics
      let acceptedCount = 0;
      let maliciousAccepted = 0;
      
      processedClients.forEach(c => {
        if (c.isAccepted) {
          acceptedCount++;
          if (c.type === 'malicious') maliciousAccepted++;
        }
      });

      // Update Acc/ASR
      // If malicious clients are accepted, ASR goes up, Acc goes down
      const attackImpact = maliciousAccepted / (acceptedCount || 1);
      
      // New Acc moves towards 0.95 (max) - impact
      const targetAcc = 0.95 - (attackImpact * 0.5);
      const newAcc = prev.globalAccuracy * 0.8 + targetAcc * 0.2; // Smooth transition

      // New ASR moves towards 1.0 if full malicious, 0 if none
      const targetASR = attackImpact > 0.1 ? 0.9 : 0.0;
      const newASR = prev.backdoorSuccessRate * 0.8 + targetASR * 0.2;

      const newHistory = [...prev.history, { round: newRound, acc: newAcc, asr: newASR }].slice(-50);

      return {
        ...prev,
        round: newRound,
        clients: processedClients,
        globalAccuracy: newAcc,
        backdoorSuccessRate: newASR,
        globalFIM: currentFIM,
        history: newHistory
      };
    });
  };

  // --- Loop Effect ---
  useEffect(() => {
    let interval: number;
    if (isPlaying) {
      interval = window.setInterval(runRound, simSpeed);
    }
    return () => clearInterval(interval);
  }, [isPlaying, simSpeed, useMomentumFIM, useStiffnessMask, useLayerWeightedClustering, nonIIDLevel, attackStealth]);

  // --- Handlers ---
  const handleReset = () => {
    setIsPlaying(false);
    setState({
      round: 0,
      globalAccuracy: 0.1,
      backdoorSuccessRate: 0,
      globalFIM: Array(VECTOR_DIM).fill(1),
      clients: [],
      history: []
    });
  };

  // --- Visualization Data Prep ---
  const scatterData = state.clients.map(c => ({
    x: c.gradient[0] + (c.gradient[2] * 0.5), // Simple projection
    y: c.gradient[1] + (c.gradient[3] * 0.5),
    z: 10,
    type: c.type,
    accepted: c.isAccepted,
    score: c.stiffnessViolationScore,
    id: c.id
  }));

  return (
    <div className="flex h-full text-slate-200">
      
      {/* Sidebar Controls */}
      <div className="w-80 bg-slate-900 border-r border-slate-700 p-6 flex flex-col gap-6 overflow-y-auto">
        <div>
          <h1 className="text-xl font-bold text-blue-400 flex items-center gap-2">
            <Shield className="w-6 h-6" />
            FedDefense Sim
          </h1>
          <p className="text-xs text-slate-500 mt-1">基于动量FIM与刚度冲突检测</p>
        </div>

        <div className="space-y-4 border-t border-slate-800 pt-4">
          <h3 className="text-sm font-semibold text-slate-400 flex items-center gap-2">
            <Zap className="w-4 h-4" /> 创新点开关 (Proposed)
          </h3>
          
          <label className="flex items-center gap-3 cursor-pointer group">
            <input 
              type="checkbox" 
              checked={useMomentumFIM} 
              onChange={e => setUseMomentumFIM(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900" 
            />
            <div className="text-sm">
              <span className="block text-slate-200 group-hover:text-blue-400 transition">动量FIM记忆 (Momentum)</span>
              <span className="text-xs text-slate-500">降低计算频率，抗时序噪声</span>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer group">
            <input 
              type="checkbox" 
              checked={useStiffnessMask} 
              onChange={e => setUseStiffnessMask(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900" 
            />
            <div className="text-sm">
              <span className="block text-slate-200 group-hover:text-blue-400 transition">刚度冲突掩码 (Stiffness)</span>
              <span className="text-xs text-slate-500">基于FIM检测“高刚度”参数违规</span>
            </div>
          </label>

           <label className="flex items-center gap-3 cursor-pointer group">
            <input 
              type="checkbox" 
              checked={useLayerWeightedClustering} 
              onChange={e => setUseLayerWeightedClustering(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-900" 
            />
            <div className="text-sm">
              <span className="block text-slate-200 group-hover:text-blue-400 transition">分层加权聚类 (Layer-Wise)</span>
              <span className="text-xs text-slate-500">降低Non-IID对聚类的干扰</span>
            </div>
          </label>
        </div>

        <div className="space-y-4 border-t border-slate-800 pt-4">
          <h3 className="text-sm font-semibold text-slate-400 flex items-center gap-2">
            <Settings className="w-4 h-4" /> 环境设置 (Environment)
          </h3>
          
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span>Non-IID Degree</span>
              <span className="text-blue-400">{nonIIDLevel.toFixed(1)}</span>
            </div>
            <input 
              type="range" min="0" max="2" step="0.1" 
              value={nonIIDLevel} onChange={e => setNonIIDLevel(parseFloat(e.target.value))}
              className="w-full accent-blue-500"
            />
            <p className="text-[10px] text-slate-500">越高则良性梯度分布越散 (Cluster Harder)</p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span>Attack Stealth (隐蔽性)</span>
              <span className="text-red-400">{attackStealth.toFixed(1)}</span>
            </div>
            <input 
              type="range" min="0" max="0.9" step="0.1" 
              value={attackStealth} onChange={e => setAttackStealth(parseFloat(e.target.value))}
              className="w-full accent-red-500"
            />
             <p className="text-[10px] text-slate-500">越高则攻击幅度越小 (Harder to detect)</p>
          </div>
        </div>

        <div className="mt-auto flex gap-2">
          <button 
            onClick={() => setIsPlaying(!isPlaying)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded font-medium transition ${isPlaying ? 'bg-red-500/10 text-red-500 border border-red-500/50 hover:bg-red-500/20' : 'bg-green-500/10 text-green-500 border border-green-500/50 hover:bg-green-500/20'}`}
          >
            {isPlaying ? 'Pause' : <><Play className="w-4 h-4"/> Start</>}
          </button>
          <button 
            onClick={handleReset}
            className="p-2 bg-slate-800 hover:bg-slate-700 rounded border border-slate-600 text-slate-300 transition"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-950">
        
        {/* Top Stats */}
        <div className="grid grid-cols-4 gap-4 p-6 border-b border-slate-800 bg-slate-900/50">
          <StatCard 
            label="Current Round" 
            value={state.round} 
            icon={<Database className="w-4 h-4 text-slate-400" />} 
          />
          <StatCard 
            label="Main Task Accuracy" 
            value={(state.globalAccuracy * 100).toFixed(1) + '%'} 
            subValue={state.history.length > 1 ? (state.globalAccuracy - state.history[state.history.length-2].acc > 0 ? '↑' : '↓') : ''}
            icon={<Activity className="w-4 h-4 text-green-400" />} 
            color="text-green-400"
          />
          <StatCard 
            label="Backdoor Success Rate" 
            value={(state.backdoorSuccessRate * 100).toFixed(1) + '%'} 
            icon={<ShieldAlert className="w-4 h-4 text-red-400" />} 
            color={state.backdoorSuccessRate > 0.1 ? "text-red-500" : "text-slate-400"}
          />
           <StatCard 
            label="Detected Malicious" 
            value={state.clients.filter(c => c.type === 'malicious' && !c.isAccepted).length + ' / ' + state.clients.filter(c => c.type === 'malicious').length} 
            icon={<Users className="w-4 h-4 text-blue-400" />} 
          />
        </div>

        {/* Visualization Grid */}
        <div className="flex-1 p-6 grid grid-cols-2 grid-rows-2 gap-6 overflow-hidden">
          
          {/* Chart 1: Metrics over time */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
            <h4 className="text-sm font-semibold text-slate-400 mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Performance Metrics
            </h4>
            <div className="flex-1 w-full min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={state.history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="round" stroke="#64748b" fontSize={12} />
                  <YAxis domain={[0, 1]} stroke="#64748b" fontSize={12} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
                    itemStyle={{ fontSize: '12px' }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="acc" name="Accuracy (良性任务)" stroke="#4ade80" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="asr" name="ASR (后门成功率)" stroke="#f87171" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Chart 2: Client Gradient Projection (PCA Simulation) */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
             <div className="flex justify-between items-center mb-4">
               <h4 className="text-sm font-semibold text-slate-400 flex items-center gap-2">
                <Users className="w-4 h-4" /> Gradient Clustering (2D Proj)
              </h4>
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Benign</span>
                <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-red-500"></div> Malicious</span>
                <span className="flex items-center gap-1"><div className="w-2 h-2 border border-slate-400"></div> Rejected</span>
              </div>
             </div>
            <div className="flex-1 w-full min-h-0 relative">
               {/* Background Zones */}
               <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
                  <div className="w-3/4 h-3/4 border-2 border-dashed border-blue-500 rounded-full"></div>
               </div>

              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis type="number" dataKey="x" name="PC1" stroke="#64748b" hide domain={[-30, 30]} />
                  <YAxis type="number" dataKey="y" name="PC2" stroke="#64748b" hide domain={[-30, 30]} />
                  <ZAxis type="number" dataKey="z" range={[50, 400]} />
                  <Tooltip 
                     cursor={{ strokeDasharray: '3 3' }}
                     content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload;
                          return (
                            <div className="bg-slate-800 border border-slate-700 p-2 rounded shadow-xl text-xs">
                              <p className="font-bold mb-1">Client #{data.id}</p>
                              <p>Type: <span className={data.type === 'malicious' ? 'text-red-400' : 'text-blue-400'}>{data.type}</span></p>
                              <p>Status: <span className={data.accepted ? 'text-green-400' : 'text-red-500 font-bold'}>{data.accepted ? 'Accepted' : 'Blocked'}</span></p>
                              <p>Conflict Score: {data.score.toFixed(2)}</p>
                            </div>
                          );
                        }
                        return null;
                     }}
                  />
                  <Scatter name="Clients" data={scatterData} shape={(props: any) => {
                    const { cx, cy, payload } = props;
                    const isMalicious = payload.type === 'malicious';
                    const isRejected = !payload.accepted;
                    const fill = isMalicious ? '#ef4444' : '#3b82f6';
                    const opacity = isRejected ? 0.3 : 1;
                    const stroke = isRejected ? '#94a3b8' : 'none';
                    const strokeWidth = isRejected ? 2 : 0;
                    
                    return (
                      <g opacity={opacity}>
                        {isMalicious ? (
                          <path d={`M${cx},${cy-6} L${cx+6},${cy+6} L${cx-6},${cy+6} Z`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                        ) : (
                          <circle cx={cx} cy={cy} r={5} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                        )}
                        {isRejected && (
                           <line x1={cx-4} y1={cy-4} x2={cx+4} y2={cy+4} stroke="white" strokeWidth={2} />
                        )}
                      </g>
                    );
                  }} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Panel 3: FIM Heatmap Visualization */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 col-span-2 flex flex-col">
             <div className="flex justify-between items-center mb-4">
                <h4 className="text-sm font-semibold text-slate-400 flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Global Momentum FIM (Stiffness Map)
                </h4>
                <span className="text-xs text-slate-500">参数索引 0-4 为高敏感区 (Stiffness High)，攻击者常在此处修改</span>
             </div>
             
             <div className="flex-1 flex items-end gap-1 min-h-0">
                {state.globalFIM.map((val, idx) => {
                  const heightPercent = Math.min(100, Math.max(10, val * 8));
                  const isHighStiffness = idx < 5;
                  return (
                    <div key={idx} className="flex-1 flex flex-col justify-end group relative">
                       <div 
                        className={`w-full rounded-t transition-all duration-500 ${isHighStiffness ? 'bg-amber-500/80' : 'bg-slate-700/50'}`} 
                        style={{ height: `${heightPercent}%` }}
                       ></div>
                       <div className="text-[9px] text-center text-slate-600 mt-1">{idx}</div>
                       
                       {/* Tooltip */}
                       <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-800 text-[10px] rounded text-white opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap border border-slate-700 z-10">
                          FIM: {val.toFixed(2)}
                       </div>
                    </div>
                  )
                })}
             </div>
          </div>

        </div>
      </div>
    </div>
  );
};

const StatCard = ({ label, value, subValue, icon, color = "text-white" }: any) => (
  <div className="bg-slate-950 border border-slate-800 p-4 rounded-lg flex flex-col gap-1">
    <div className="flex items-center justify-between text-slate-500 text-xs uppercase font-medium tracking-wider">
      {label}
      {icon}
    </div>
    <div className={`text-2xl font-bold ${color} flex items-end gap-2`}>
      {value}
      {subValue && <span className="text-sm text-slate-500 mb-1">{subValue}</span>}
    </div>
  </div>
);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
