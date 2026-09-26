import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  TERMINALS,
  buildBenchmarkGraph,
  evaluateSchedule,
  validateFeasibility,
} from './simulator';
import {
  createDestroyedFragment,
  executeCpSatRepairStep,
  executeCpSatBridgeRepair,
  checkCpSatBridge,
  CpSatStatus,
} from './lns_runner';
import {
  DestroyOperatorKind,
  DestroyedFragment,
  IncumbentSchedule,
  LnsIterationLog,
  ObjectiveWeights,
} from './types/rake_allocation';

// ─── Icon Components (inline SVG to avoid heavy icon lib) ────────────────────
const Icon = ({ d, size = 16, className = '' }: { d: string; size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d={d} />
  </svg>
);

const PlayIcon = () => <Icon d="M5 3l14 9-14 9V3z" />;
const PauseIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>;
const StepIcon = () => <Icon d="M5 4l10 8-10 8V4zM19 5v14" />;
const ResetIcon = () => <Icon d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />;
const CheckIcon = ({ className = '' }: { className?: string }) => <Icon d="M20 6L9 17l-5-5" className={className} />;
const XIcon = ({ className = '' }: { className?: string }) => <Icon d="M18 6L6 18M6 6l12 12" className={className} />;
const ChevronDown = ({ className = '' }: { className?: string }) => <Icon d="M6 9l6 6 6-6" className={className} />;
const ChevronRight = ({ className = '' }: { className?: string }) => <Icon d="M9 18l6-6-6-6" className={className} />;
const StarIcon = () => <Icon d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />;

type TabId = 'overview' | 'trace' | 'schedule' | 'network' | 'model';

const TAB_CONFIG: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'trace', label: 'Solver Trace' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'network', label: 'Network' },
  { id: 'model', label: 'Model' },
];

// ─── Utility ─────────────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('en-IN');
const fmtCost = (n: number) => `₹${fmt(Math.round(n))}`;
const operatorLabel = (op: DestroyOperatorKind) => {
  switch (op) {
    case 'RandomTimeWindow': return 'Time Window';
    case 'GeographicCluster': return 'Geographic';
    case 'HighDetentionTargeted': return 'High Detention';
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // ─── Benchmark & Solver State ──────────────────────────────────────────
  const benchmark = useMemo(() => buildBenchmarkGraph(36), []);
  const [incumbent, setIncumbent] = useState<IncumbentSchedule>(() => benchmark.initialSchedule);
  const [bestSchedule, setBestSchedule] = useState<IncumbentSchedule>(() => benchmark.initialSchedule);
  const [iterationHistory, setIterationHistory] = useState<LnsIterationLog[]>([]);
  const [currentIter, setCurrentIter] = useState(0);
  const [lastFragment, setLastFragment] = useState<DestroyedFragment | null>(null);
  const [selectedOperator, setSelectedOperator] = useState<DestroyOperatorKind>('RandomTimeWindow');
  const [windowDuration, setWindowDuration] = useState(8);
  const [clusterCenter] = useState(0);
  const [temperature, setTemperature] = useState(1500.0);
  const [coolingRate] = useState(0.95);
  const [weights] = useState<ObjectiveWeights>({
    w_unserved: 5000,
    w_empty_km: 2.5,
    w_detention_hr: 15.0,
    w_lateness: 250.0,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [selectedIteration, setSelectedIteration] = useState<LnsIterationLog | null>(null);
  const [filterRakeId, setFilterRakeId] = useState<number | 'ALL'>('ALL');
  const [expandedConstraints, setExpandedConstraints] = useState<Set<number>>(new Set());
  const [expandedModelSections, setExpandedModelSections] = useState<Set<string>>(new Set());
  const [startTime] = useState(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cpSatAvailable, setCpSatAvailable] = useState(false);
  const [lastCpSatStatus, setLastCpSatStatus] = useState<CpSatStatus>('HEURISTIC');
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedRef = useRef<NodeJS.Timeout | null>(null);
  const steppingRef = useRef(false);

  // ─── Check CP-SAT bridge on mount ──────────────────────────────────────
  useEffect(() => {
    checkCpSatBridge().then(available => {
      setCpSatAvailable(available);
      if (available) console.log('[App] CP-SAT bridge detected at localhost:3001');
      else console.log('[App] CP-SAT bridge not available, using heuristic repair');
    });
  }, []);

  // ─── Feasibility ───────────────────────────────────────────────────────
  const feasibility = useMemo(() => {
    return validateFeasibility(
      bestSchedule,
      benchmark.graph.arcs,
      benchmark.graph.maintenance,
      benchmark.graph.terminalCapacities,
      benchmark.graph.sectionCapacities,
      benchmark.graph.minServicing
    );
  }, [bestSchedule, benchmark]);

  const feasibilityCount = useMemo(() => {
    const checks = [
      feasibility.rake_conservation_violations,
      feasibility.terminal_capacity_violations,
      feasibility.section_capacity_violations,
      feasibility.compatibility_violations,
      feasibility.servicing_turnaround_violations,
      feasibility.maintenance_window_violations,
    ];
    return checks.filter(v => v.length === 0).length;
  }, [feasibility]);

  // ─── Cost Reduction ────────────────────────────────────────────────────
  const costReduction = useMemo(() => {
    const init = benchmark.initialSchedule.score.total_weighted_cost;
    const cur = bestSchedule.score.total_weighted_cost;
    if (init <= 0) return '0.0';
    return (((init - cur) / init) * 100).toFixed(1);
  }, [benchmark, bestSchedule]);

  // ─── Elapsed timer ─────────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      elapsedRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTime);
      }, 200);
    } else if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current); };
  }, [isRunning, startTime]);

  // ─── Single LNS Step (sync heuristic) ─────────────────────────────────
  const stepLnsSync = useCallback(() => {
    const fragment = createDestroyedFragment(
      incumbent,
      benchmark.graph.arcs,
      benchmark.graph.demands,
      benchmark.graph.horizon,
      TERMINALS.length,
      selectedOperator,
      windowDuration,
      clusterCenter
    );
    setLastFragment(fragment);

    const { repairedSchedule, solveDurationMs, cpSatStatus } = executeCpSatRepairStep(
      incumbent,
      fragment,
      benchmark.graph.arcs,
      benchmark.graph.demands,
      benchmark.graph.maintenance,
      benchmark.graph.terminalCapacities,
      benchmark.graph.sectionCapacities,
      benchmark.graph.minServicing,
      weights
    );

    setLastCpSatStatus(cpSatStatus);
    const nextIter = currentIter + 1;
    setCurrentIter(nextIter);

    const candidateCost = repairedSchedule.score.total_weighted_cost;
    const currentCost = incumbent.score.total_weighted_cost;
    const delta = candidateCost - currentCost;

    let accepted = false;
    if (delta <= 0) {
      accepted = true;
    } else {
      const prob = Math.exp(-delta / Math.max(1, temperature));
      accepted = Math.random() < prob;
    }

    const nextTemp = Math.max(1, temperature * coolingRate);
    setTemperature(nextTemp);

    let isNewBest = false;
    let nextBest = bestSchedule;

    if (accepted) {
      setIncumbent(repairedSchedule);
      if (candidateCost < bestSchedule.score.total_weighted_cost) {
        setBestSchedule(repairedSchedule);
        nextBest = repairedSchedule;
        isNewBest = true;
      }
    }

    const logEntry: LnsIterationLog = {
      iteration: nextIter,
      operator: selectedOperator,
      candidate_cost: candidateCost,
      incumbent_cost: accepted ? candidateCost : currentCost,
      best_cost: nextBest.score.total_weighted_cost,
      accepted,
      is_new_best: isNewBest,
      temperature,
      score_breakdown: (accepted ? repairedSchedule : incumbent).score,
      solve_duration_ms: solveDurationMs,
      destroy_meta: fragment.destroy_meta,
    };

    setIterationHistory((prev) => [logEntry, ...prev.slice(0, 199)]);
  }, [incumbent, bestSchedule, benchmark, currentIter, temperature, coolingRate, selectedOperator, windowDuration, clusterCenter, weights]);

  // ─── Async LNS Step (with CP-SAT bridge) ──────────────────────────────
  const stepLnsAsync = useCallback(async () => {
    if (steppingRef.current) return; // prevent concurrent
    steppingRef.current = true;

    const fragment = createDestroyedFragment(
      incumbent,
      benchmark.graph.arcs,
      benchmark.graph.demands,
      benchmark.graph.horizon,
      TERMINALS.length,
      selectedOperator,
      windowDuration,
      clusterCenter
    );
    setLastFragment(fragment);

    const { repairedSchedule, solveDurationMs, cpSatStatus } = await executeCpSatBridgeRepair(
      incumbent,
      fragment,
      benchmark.graph.arcs,
      benchmark.graph.demands,
      benchmark.graph.maintenance,
      benchmark.graph.terminalCapacities,
      benchmark.graph.sectionCapacities,
      benchmark.graph.minServicing,
      weights
    );

    setLastCpSatStatus(cpSatStatus);
    const nextIter = currentIter + 1;
    setCurrentIter(nextIter);

    const candidateCost = repairedSchedule.score.total_weighted_cost;
    const currentCost = incumbent.score.total_weighted_cost;
    const delta = candidateCost - currentCost;

    let accepted = false;
    if (delta <= 0) {
      accepted = true;
    } else {
      const prob = Math.exp(-delta / Math.max(1, temperature));
      accepted = Math.random() < prob;
    }

    const nextTemp = Math.max(1, temperature * coolingRate);
    setTemperature(nextTemp);

    let isNewBest = false;
    let nextBest = bestSchedule;

    if (accepted) {
      setIncumbent(repairedSchedule);
      if (candidateCost < bestSchedule.score.total_weighted_cost) {
        setBestSchedule(repairedSchedule);
        nextBest = repairedSchedule;
        isNewBest = true;
      }
    }

    const logEntry: LnsIterationLog = {
      iteration: nextIter,
      operator: selectedOperator,
      candidate_cost: candidateCost,
      incumbent_cost: accepted ? candidateCost : currentCost,
      best_cost: nextBest.score.total_weighted_cost,
      accepted,
      is_new_best: isNewBest,
      temperature,
      score_breakdown: (accepted ? repairedSchedule : incumbent).score,
      solve_duration_ms: solveDurationMs,
      destroy_meta: fragment.destroy_meta,
    };

    setIterationHistory((prev) => [logEntry, ...prev.slice(0, 199)]);
    steppingRef.current = false;
  }, [incumbent, bestSchedule, benchmark, currentIter, temperature, coolingRate, selectedOperator, windowDuration, clusterCenter, weights]);

  // Use async step when CP-SAT is available, sync otherwise
  const stepLns = useCallback(() => {
    if (cpSatAvailable) {
      stepLnsAsync();
    } else {
      stepLnsSync();
    }
  }, [cpSatAvailable, stepLnsAsync, stepLnsSync]);

  // ─── Run / Pause loop ──────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => { stepLns(); }, 400);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRunning, stepLns]);

  const resetAll = () => {
    setIsRunning(false);
    setIncumbent(benchmark.initialSchedule);
    setBestSchedule(benchmark.initialSchedule);
    setIterationHistory([]);
    setCurrentIter(0);
    setTemperature(1500.0);
    setLastFragment(null);
    setSelectedIteration(null);
  };

  const solverStatus = useMemo(() => {
    if (isRunning) return 'RUNNING';
    if (currentIter === 0) return 'IDLE';
    return feasibility.is_feasible ? 'FEASIBLE' : 'INFEASIBLE';
  }, [isRunning, currentIter, feasibility]);

  const statusColor = {
    RUNNING: 'text-amber-400',
    IDLE: 'text-slate-400',
    FEASIBLE: 'text-emerald-400',
    INFEASIBLE: 'text-rose-400',
  }[solverStatus];

  const statusDot = {
    RUNNING: 'bg-amber-400 animate-pulse-dot',
    IDLE: 'bg-slate-500',
    FEASIBLE: 'bg-emerald-400',
    INFEASIBLE: 'bg-rose-400',
  }[solverStatus];

  // ─── Convergence data ──────────────────────────────────────────────────
  const convergenceData = useMemo(() => {
    return [...iterationHistory].reverse();
  }, [iterationHistory]);

  const toggleConstraint = (idx: number) => {
    setExpandedConstraints(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleModelSection = (key: string) => {
    setExpandedModelSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#070B14', fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b px-5 py-3 flex items-center justify-between" style={{ background: 'rgba(13,20,34,0.95)', borderColor: '#1E2A3D', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black" style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)', color: '#070B14' }}>
            287
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight" style={{ color: '#F1F5F9' }}>
              PRJ 287 <span className="font-normal" style={{ color: '#94A3B8' }}>Rake Scheduling Engine</span>
            </h1>
            <p className="text-xs" style={{ color: '#64748B' }}>
              Large-Neighbourhood Search for Railway Rake Allocation
              <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] uppercase font-medium" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.2)' }}>
                Synthetic Benchmark
              </span>
            </p>
          </div>
        </div>

        {/* Solver Status */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
            <div className={`w-2 h-2 rounded-full ${statusDot}`} />
            <span className={`font-mono font-semibold ${statusColor}`}>{solverStatus}</span>
          </div>

          {/* Navigation */}
          <nav className="flex items-center rounded-lg p-0.5" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
            {TAB_CONFIG.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
                style={{
                  background: activeTab === tab.id ? '#F59E0B' : 'transparent',
                  color: activeTab === tab.id ? '#070B14' : '#94A3B8',
                  fontWeight: activeTab === tab.id ? 700 : 500,
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-5 py-5 space-y-5">

          {/* ═══ OVERVIEW TAB ═══════════════════════════════════════════════ */}
          {activeTab === 'overview' && (
            <div className="space-y-5 animate-slide-in">

              {/* Solver Controls Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsRunning(!isRunning)}
                    className="px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all"
                    style={{
                      background: isRunning ? '#FB7185' : '#34D399',
                      color: '#070B14',
                    }}
                  >
                    {isRunning ? <PauseIcon /> : <PlayIcon />}
                    {isRunning ? 'Pause' : 'Run LNS'}
                  </button>
                  <button
                    onClick={stepLns}
                    disabled={isRunning}
                    className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all disabled:opacity-40"
                    style={{ background: '#121B2C', color: '#F1F5F9', border: '1px solid #1E2A3D' }}
                  >
                    <StepIcon /> Step
                  </button>
                  <button
                    onClick={resetAll}
                    className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-all"
                    style={{ background: '#121B2C', color: '#94A3B8', border: '1px solid #1E2A3D' }}
                  >
                    <ResetIcon /> Reset
                  </button>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  {/* CP-SAT Bridge Status */}
                  <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg" style={{ background: '#070B14', border: '1px solid #162033' }}>
                    <div className={`w-2 h-2 rounded-full ${cpSatAvailable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span style={{ color: cpSatAvailable ? '#34D399' : '#64748B', fontWeight: 600 }}>
                      {cpSatAvailable ? 'CP-SAT Connected' : 'Heuristic Mode'}
                    </span>
                  </div>

                  {/* Destroy Operator */}
                  <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg" style={{ background: '#070B14', border: '1px solid #162033' }}>
                    <span style={{ color: '#64748B' }}>Destroy:</span>
                    {(['RandomTimeWindow', 'GeographicCluster', 'HighDetentionTargeted'] as DestroyOperatorKind[]).map(op => (
                      <button
                        key={op}
                        onClick={() => setSelectedOperator(op)}
                        className="px-2 py-1 rounded text-xs transition-all"
                        style={{
                          background: selectedOperator === op ? 'rgba(245,158,11,0.15)' : 'transparent',
                          color: selectedOperator === op ? '#F59E0B' : '#64748B',
                          border: selectedOperator === op ? '1px solid rgba(245,158,11,0.3)' : '1px solid transparent',
                          fontWeight: selectedOperator === op ? 600 : 400,
                        }}
                      >
                        {operatorLabel(op)}
                      </button>
                    ))}
                  </div>

                  {/* Window Duration */}
                  <div className="flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg" style={{ background: '#070B14', border: '1px solid #162033' }}>
                    <span style={{ color: '#64748B' }}>Window:</span>
                    <input
                      type="range" min={4} max={16}
                      value={windowDuration}
                      onChange={e => setWindowDuration(Number(e.target.value))}
                      className="w-16 accent-amber-500"
                    />
                    <span className="font-mono font-bold" style={{ color: '#F59E0B' }}>{windowDuration}h</span>
                  </div>
                </div>
              </div>

              {/* KPI Cards Row */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <KpiCard
                  label="Baseline Objective"
                  value={fmtCost(benchmark.initialSchedule.score.total_weighted_cost)}
                  sub="Initial schedule cost"
                  color="#94A3B8"
                />
                <KpiCard
                  label="Best Objective"
                  value={fmtCost(bestSchedule.score.total_weighted_cost)}
                  sub={`Iteration #${currentIter}`}
                  color="#34D399"
                  highlight
                />
                <KpiCard
                  label="Improvement"
                  value={`${costReduction}%`}
                  sub="Cost reduction"
                  color="#34D399"
                />
                <KpiCard
                  label="Iteration"
                  value={`${currentIter}`}
                  sub={`Temp: ${temperature.toFixed(0)}°`}
                  color="#F59E0B"
                  mono
                />
                <KpiCard
                  label="Feasibility"
                  value={`${feasibilityCount}/6`}
                  sub={feasibility.is_feasible ? 'All satisfied' : 'Violations detected'}
                  color={feasibility.is_feasible ? '#34D399' : '#FB7185'}
                />
              </div>

              {/* Two-column: Pipeline + Convergence */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Solver Pipeline */}
                <div className="lg:col-span-4">
                  <SectionCard title="LNS Pipeline" subtitle={`Iteration #${currentIter}`}>
                    <PipelineStage
                      label="DESTROY"
                      status={lastFragment ? 'complete' : 'waiting'}
                      detail={lastFragment ? `${operatorLabel(lastFragment.operator_used)} · ${lastFragment.destroy_meta}` : 'Awaiting iteration'}
                    />
                    <PipelineArrow />
                    <PipelineStage
                      label="REPAIR"
                      status={lastFragment ? 'complete' : 'waiting'}
                      detail={lastFragment
                        ? (lastCpSatStatus === 'OPTIMAL' || lastCpSatStatus === 'FEASIBLE'
                          ? `CP-SAT ${lastCpSatStatus} · ${lastFragment.incoming_boundary.length} boundary pins`
                          : `Greedy heuristic repair · ${lastFragment.incoming_boundary.length} boundary pins`)
                        : (cpSatAvailable ? 'CP-SAT repair (bridge connected)' : 'Heuristic repair solver')
                      }
                    />
                    <PipelineArrow />
                    <PipelineStage
                      label="VALIDATE"
                      status={currentIter > 0 ? (feasibility.is_feasible ? 'complete' : 'error') : 'waiting'}
                      detail={currentIter > 0 ? `${feasibilityCount}/6 constraints satisfied` : 'Feasibility check'}
                    />
                    <PipelineArrow />
                    <PipelineStage
                      label="DECISION"
                      status={iterationHistory.length > 0 ? 'complete' : 'waiting'}
                      detail={iterationHistory.length > 0
                        ? (iterationHistory[0].is_new_best
                          ? '★ NEW BEST'
                          : iterationHistory[0].accepted ? 'Accepted (SA)' : 'Rejected')
                        : 'Accept/Reject via SA'}
                      highlight={iterationHistory.length > 0 && iterationHistory[0].is_new_best}
                    />
                  </SectionCard>
                </div>

                {/* Convergence Chart */}
                <div className="lg:col-span-8">
                  <SectionCard title="Convergence" subtitle="Objective value over iterations">
                    {convergenceData.length > 1 ? (
                      <ConvergenceChart data={convergenceData} baselineCost={benchmark.initialSchedule.score.total_weighted_cost} />
                    ) : (
                      <div className="h-48 flex items-center justify-center text-sm" style={{ color: '#64748B' }}>
                        Run the solver to visualize convergence
                      </div>
                    )}
                  </SectionCard>
                </div>
              </div>

              {/* Two-column: Objective Breakdown + Constraint Status */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Objective Breakdown */}
                <SectionCard title="Objective Breakdown" subtitle="Synthetic benchmark cost components">
                  <ObjectiveBreakdown score={bestSchedule.score} />
                </SectionCard>

                {/* Constraint Status */}
                <SectionCard title="Constraint Status" subtitle={`${feasibilityCount}/6 constraints satisfied`}>
                  <div className="space-y-1.5">
                    {[
                      { name: 'Rake Flow Conservation', violations: feasibility.rake_conservation_violations },
                      { name: 'Terminal Capacity', violations: feasibility.terminal_capacity_violations },
                      { name: 'Section Capacity', violations: feasibility.section_capacity_violations },
                      { name: 'Stock Compatibility', violations: feasibility.compatibility_violations },
                      { name: 'Servicing Turnaround', violations: feasibility.servicing_turnaround_violations },
                      { name: 'Maintenance Windows', violations: feasibility.maintenance_window_violations },
                    ].map((c, idx) => (
                      <div key={idx}>
                        <button
                          onClick={() => toggleConstraint(idx)}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all"
                          style={{
                            background: expandedConstraints.has(idx) ? '#121B2C' : 'transparent',
                            border: '1px solid transparent',
                          }}
                        >
                          {c.violations.length === 0
                            ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            : <XIcon className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          }
                          <span style={{ color: '#F1F5F9' }}>{c.name}</span>
                          {c.violations.length > 0 && (
                            <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: 'rgba(251,113,133,0.1)', color: '#FB7185' }}>
                              {c.violations.length} violations
                            </span>
                          )}
                          {c.violations.length > 0 && (
                            expandedConstraints.has(idx)
                              ? <ChevronDown className="w-3 h-3 shrink-0" />
                              : <ChevronRight className="w-3 h-3 shrink-0" />
                          )}
                        </button>
                        {expandedConstraints.has(idx) && c.violations.length > 0 && (
                          <div className="ml-8 mt-1 space-y-1 text-[11px] font-mono max-h-24 overflow-y-auto" style={{ color: '#FB7185' }}>
                            {c.violations.map((v, i) => <div key={i}>• {v}</div>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </SectionCard>
              </div>
            </div>
          )}

          {/* ═══ SOLVER TRACE TAB ════════════════════════════════════════════ */}
          {activeTab === 'trace' && (
            <div className="space-y-5 animate-slide-in">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Iteration Timeline */}
                <div className="lg:col-span-5">
                  <SectionCard title="Solver Trace" subtitle={`${iterationHistory.length} iterations recorded`}>
                    {iterationHistory.length > 0 ? (
                      <div className="space-y-1 max-h-[600px] overflow-y-auto pr-1">
                        {iterationHistory.map(log => (
                          <button
                            key={log.iteration}
                            onClick={() => setSelectedIteration(log)}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs transition-all text-left"
                            style={{
                              background: selectedIteration?.iteration === log.iteration ? '#121B2C' : 'transparent',
                              border: selectedIteration?.iteration === log.iteration ? '1px solid #1E2A3D' : '1px solid transparent',
                            }}
                          >
                            <span className="font-mono font-bold w-8 text-right shrink-0" style={{ color: '#64748B' }}>
                              #{log.iteration}
                            </span>
                            <span className="w-20 shrink-0" style={{ color: '#F59E0B' }}>
                              {operatorLabel(log.operator)}
                            </span>
                            <span className="flex-1" />
                            {log.is_new_best ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1" style={{ background: 'rgba(52,211,153,0.15)', color: '#34D399', border: '1px solid rgba(52,211,153,0.3)' }}>
                                <StarIcon /> NEW BEST
                              </span>
                            ) : log.accepted ? (
                              <span className="px-2 py-0.5 rounded text-[10px]" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B' }}>
                                ACCEPTED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px]" style={{ background: '#121B2C', color: '#64748B' }}>
                                REJECTED
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="py-12 text-center text-sm" style={{ color: '#64748B' }}>
                        No iterations yet. Start the solver to see the trace.
                      </div>
                    )}
                  </SectionCard>
                </div>

                {/* Iteration Inspector */}
                <div className="lg:col-span-7">
                  <SectionCard title="Iteration Inspector" subtitle={selectedIteration ? `Iteration #${selectedIteration.iteration}` : 'Select an iteration'}>
                    {selectedIteration ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="col-span-2">
                            <DetailCell label="Destroy Operator" value={operatorLabel(selectedIteration.operator)} />
                            {selectedIteration.destroy_meta && (
                              <div className="text-xs mt-1.5 p-2 rounded font-mono" style={{ background: '#070B14', border: '1px solid #162033', color: '#94A3B8' }}>
                                {selectedIteration.destroy_meta}
                              </div>
                            )}
                          </div>
                          <DetailCell label="Solve Time" value={`${selectedIteration.solve_duration_ms}ms`} />
                          <DetailCell label="Candidate Objective" value={fmtCost(selectedIteration.candidate_cost)} />
                          <DetailCell label="Best Objective" value={fmtCost(selectedIteration.best_cost)} highlight />
                          <DetailCell label="Temperature" value={`${selectedIteration.temperature.toFixed(1)}°`} />
                          <DetailCell
                            label="Decision"
                            value={selectedIteration.is_new_best ? '★ NEW BEST' : selectedIteration.accepted ? 'ACCEPTED' : 'REJECTED'}
                            highlight={selectedIteration.is_new_best}
                          />
                        </div>

                        <div className="pt-2 border-t" style={{ borderColor: '#1E2A3D' }}>
                          <div className="text-xs font-medium mb-2" style={{ color: '#94A3B8' }}>Score Breakdown</div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <DetailCell label="Unserved Demands" value={`${selectedIteration.score_breakdown.unserved_demands_count} (${fmtCost(selectedIteration.score_breakdown.unserved_penalty)})`} />
                            <DetailCell label="Empty Repositioning" value={`${fmt(selectedIteration.score_breakdown.total_empty_km)}km (${fmtCost(selectedIteration.score_breakdown.empty_km_cost)})`} />
                            <DetailCell label="Detention" value={`${selectedIteration.score_breakdown.total_detention_hours}hrs (${fmtCost(selectedIteration.score_breakdown.detention_cost)})`} />
                            <DetailCell label="Lateness" value={`${selectedIteration.score_breakdown.total_lateness_buckets} buckets (${fmtCost(selectedIteration.score_breakdown.lateness_penalty)})`} />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="py-16 text-center text-sm" style={{ color: '#64748B' }}>
                        Click an iteration from the trace to inspect its details
                      </div>
                    )}
                  </SectionCard>
                </div>
              </div>
            </div>
          )}

          {/* ═══ SCHEDULE TAB ════════════════════════════════════════════════ */}
          {activeTab === 'schedule' && (
            <div className="space-y-5 animate-slide-in">
              <SectionCard title="Best Schedule" subtitle={`Fleet of ${benchmark.fleet.length} rakes · ${currentIter > 0 ? `After ${currentIter} iterations` : 'Initial assignment'}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" style={{ borderCollapse: 'separate', borderSpacing: '0 2px' }}>
                    <thead>
                      <tr style={{ color: '#64748B' }}>
                        <th className="text-left py-2 px-3 font-medium">Rake</th>
                        <th className="text-left py-2 px-3 font-medium">Type</th>
                        <th className="text-left py-2 px-3 font-medium">Initial</th>
                        <th className="text-left py-2 px-3 font-medium">Route Summary</th>
                        <th className="text-left py-2 px-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchmark.fleet.map(rake => {
                        const path = bestSchedule.rake_paths[rake.rake_id] || [];
                        const route = summarizeRoute(path, benchmark.graph.arcs);
                        return (
                          <tr key={rake.rake_id} className="transition-all" style={{ background: '#0D1422' }}>
                            <td className="py-2.5 px-3 font-mono font-bold rounded-l-lg" style={{ color: '#F1F5F9' }}>
                              #{rake.rake_id}
                              {rake.name && <span className="ml-1.5 font-normal" style={{ color: '#64748B' }}>{rake.name}</span>}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold" style={{
                                background: rake.stock_type === 'BOBRN' ? 'rgba(245,158,11,0.1)' : rake.stock_type === 'BOXN' ? 'rgba(34,211,238,0.1)' : rake.stock_type === 'BCN' ? 'rgba(139,92,246,0.1)' : 'rgba(251,191,36,0.1)',
                                color: rake.stock_type === 'BOBRN' ? '#F59E0B' : rake.stock_type === 'BOXN' ? '#22D3EE' : rake.stock_type === 'BCN' ? '#8B5CF6' : '#FBBF24',
                              }}>
                                {rake.stock_type}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono" style={{ color: '#94A3B8' }}>
                              {TERMINALS[rake.initial_terminal]?.code}
                            </td>
                            <td className="py-2.5 px-3" style={{ color: '#94A3B8' }}>
                              {route.length > 0 ? (
                                <div className="flex items-center gap-1 flex-wrap">
                                  {route.map((seg, i) => (
                                    <span key={i} className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{
                                      background: seg.type === 'LOADED' ? 'rgba(52,211,153,0.1)' : seg.type === 'EMPTY' ? 'rgba(245,158,11,0.1)' : seg.type === 'SERVICE' ? 'rgba(34,211,238,0.1)' : 'rgba(100,116,139,0.1)',
                                      color: seg.type === 'LOADED' ? '#34D399' : seg.type === 'EMPTY' ? '#F59E0B' : seg.type === 'SERVICE' ? '#22D3EE' : '#64748B',
                                    }}>
                                      {seg.label}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span style={{ color: '#475569' }}>Dwelling at initial terminal</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 rounded-r-lg">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium" style={{
                                background: route.some(r => r.type === 'LOADED') ? 'rgba(52,211,153,0.1)' : 'rgba(100,116,139,0.1)',
                                color: route.some(r => r.type === 'LOADED') ? '#34D399' : '#64748B',
                              }}>
                                {route.some(r => r.type === 'LOADED') ? 'Active' : 'Idle'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </SectionCard>

              {/* Demand Fulfillment */}
              <SectionCard title="Demand Fulfillment" subtitle="Transport demand assignments">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {benchmark.graph.demands.map(d => {
                    const served = bestSchedule.demand_fulfillment[d.demand_id];
                    return (
                      <div key={d.demand_id} className="p-3 rounded-lg" style={{ background: '#070B14', border: '1px solid #162033' }}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-xs font-bold" style={{ color: '#F1F5F9' }}>
                            Demand #{d.demand_id}
                          </span>
                          <span className="px-1.5 py-0.5 rounded text-[10px]" style={{
                            background: served ? 'rgba(52,211,153,0.1)' : 'rgba(251,113,133,0.1)',
                            color: served ? '#34D399' : '#FB7185',
                          }}>
                            {served ? 'Served' : 'Unserved'}
                          </span>
                        </div>
                        <div className="text-[11px] space-y-1" style={{ color: '#94A3B8' }}>
                          <div>{TERMINALS[d.origin_terminal]?.code} → {TERMINALS[d.dest_terminal]?.code}</div>
                          <div>{d.commodity} · {d.quantity_rakes} rakes</div>
                          <div>Due: t={d.due_time_bucket}h</div>
                          {served && <div className="font-mono" style={{ color: '#34D399' }}>Rake #{served.rake_id} arrives t={served.arrival_bucket}h</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            </div>
          )}

          {/* ═══ NETWORK TAB ═════════════════════════════════════════════════ */}
          {activeTab === 'network' && (
            <div className="space-y-5 animate-slide-in">
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
                <div>
                  <h2 className="text-sm font-bold" style={{ color: '#F1F5F9' }}>Time-Expanded Network</h2>
                  <p className="text-xs" style={{ color: '#64748B' }}>Terminal × Time Bucket × Rake Trajectories</p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span style={{ color: '#64748B' }}>Filter:</span>
                  <select
                    value={filterRakeId}
                    onChange={e => setFilterRakeId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
                    className="px-2.5 py-1 rounded font-mono text-xs"
                    style={{ background: '#070B14', border: '1px solid #1E2A3D', color: '#F1F5F9' }}
                  >
                    <option value="ALL">All Rakes ({benchmark.fleet.length})</option>
                    {benchmark.fleet.map(r => (
                      <option key={r.rake_id} value={r.rake_id}>Rake #{r.rake_id} {r.stock_type}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-4 text-xs px-3 py-2 rounded-lg" style={{ background: '#0D1422', border: '1px solid #1E2A3D', color: '#94A3B8' }}>
                <span style={{ color: '#64748B' }}>Legend:</span>
                <LegendDot color="#34D399" label="Loaded" />
                <LegendDot color="#F59E0B" label="Empty" />
                <LegendDot color="#475569" label="Dwell" />
                <LegendDot color="#22D3EE" label="Servicing" />
                <LegendDot color="#FB7185" label="Maintenance" />
                {lastFragment && <LegendDot color="rgba(245,158,11,0.5)" label="Destroyed Region" />}
              </div>

              {/* Network Grid */}
              <div className="rounded-xl overflow-x-auto p-4" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
                <div className="min-w-[900px]">
                  {/* Time axis header */}
                  <div className="grid grid-cols-37 gap-1 mb-2 text-center">
                    <div className="text-left text-xs font-medium pr-2" style={{ color: '#94A3B8' }}>Terminal</div>
                    {Array.from({ length: 37 }).map((_, b) => (
                      <div key={b} className="text-[10px] font-mono" style={{ color: b % 6 === 0 ? '#F59E0B' : '#334155' }}>
                        {b % 6 === 0 ? `${b}h` : '·'}
                      </div>
                    ))}
                  </div>

                  {/* Terminal rows */}
                  <div className="space-y-2">
                    {TERMINALS.map(term => (
                      <div key={term.id} className="rounded-lg p-2" style={{ background: '#070B14', border: '1px solid #162033' }}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: term.color }} />
                          <span className="text-xs font-bold" style={{ color: '#F1F5F9' }}>{term.name}</span>
                          <span className="text-[10px] font-mono" style={{ color: '#475569' }}>[{term.code}]</span>
                        </div>

                        <div className="grid grid-cols-37 gap-1">
                          <div className="text-[10px] font-mono flex items-center" style={{ color: '#475569' }}>T#{term.id}</div>
                          {Array.from({ length: 37 }).map((_, bucket) => {
                            const isDestroyedWindow = lastFragment &&
                              bucket >= lastFragment.t_start && bucket <= lastFragment.t_end &&
                              lastFragment.affected_terminals.includes(term.id);
                            const isMaintenance = benchmark.graph.maintenance.some(
                              mw => mw.terminal_id === term.id && bucket >= mw.start_bucket && bucket <= mw.end_bucket &&
                                (filterRakeId === 'ALL' || filterRakeId === mw.rake_id)
                            );
                            const presentRakes: number[] = [];
                            for (const [ridStr, path] of Object.entries(bestSchedule.rake_paths)) {
                              const rid = Number(ridStr);
                              if (filterRakeId !== 'ALL' && filterRakeId !== rid) continue;
                              for (const aid of path) {
                                const arc = benchmark.graph.arcs[aid];
                                if (arc && arc.from_node.terminal_id === term.id && arc.from_node.time_bucket === bucket) {
                                  presentRakes.push(rid);
                                  break;
                                }
                              }
                            }

                            let bg = '#0D1422';
                            let borderC = '#162033';
                            let textC = '#334155';
                            if (isMaintenance) { bg = 'rgba(251,113,133,0.08)'; borderC = 'rgba(251,113,133,0.3)'; textC = '#FB7185'; }
                            else if (isDestroyedWindow) { bg = 'rgba(245,158,11,0.06)'; borderC = 'rgba(245,158,11,0.3)'; textC = '#F59E0B'; }
                            else if (presentRakes.length > 0) { bg = '#121B2C'; borderC = '#1E2A3D'; textC = '#F1F5F9'; }

                            return (
                              <div
                                key={bucket}
                                className="h-8 rounded flex flex-col items-center justify-center text-[9px] font-mono transition-all"
                                style={{ background: bg, border: `1px solid ${borderC}`, color: textC }}
                                title={`${term.name} (${term.code}) · t=${bucket}h · Rakes: ${presentRakes.length > 0 ? presentRakes.join(', ') : 'None'}`}
                              >
                                {isMaintenance ? (
                                  <span className="text-[8px]">🔧</span>
                                ) : presentRakes.length > 0 ? (
                                  <div className="flex flex-col items-center leading-tight">
                                    <span className="font-bold" style={{ color: '#F59E0B' }}>R{presentRakes[0]}</span>
                                    {presentRakes.length > 1 && <span className="text-[7px]" style={{ color: '#64748B' }}>+{presentRakes.length - 1}</span>}
                                  </div>
                                ) : (
                                  <span className="opacity-20">·</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ═══ MODEL TAB ═══════════════════════════════════════════════════ */}
          {activeTab === 'model' && (
            <div className="space-y-5 animate-slide-in">
              <SectionCard title="Optimization Model" subtitle="CP-SAT formulation for repair subproblems">
                <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
                  The LNS repair phase uses a constraint satisfaction formulation. This page describes the mathematical model
                  defined in <code className="font-mono px-1 py-0.5 rounded text-[11px]" style={{ background: '#070B14', color: '#F59E0B' }}>solver_repair.py</code>.
                  The current runtime uses a greedy heuristic repair; the full CP-SAT formulation is available for exact subproblem solving.
                </p>

                {/* Decision Variables */}
                <ModelSection
                  title="Decision Variables"
                  expanded={expandedModelSections.has('vars')}
                  onToggle={() => toggleModelSection('vars')}
                >
                  <div className="space-y-2 font-mono text-xs" style={{ color: '#94A3B8' }}>
                    <div><span style={{ color: '#F59E0B' }}>x[a, r]</span> <span style={{ color: '#64748B' }}>∈ {'{0, 1}'}</span> — Rake r traverses arc a</div>
                    <div><span style={{ color: '#F59E0B' }}>u[d]</span> <span style={{ color: '#64748B' }}>∈ {'{0, 1}'}</span> — Demand d remains unserved</div>
                    <div><span style={{ color: '#F59E0B' }}>lateness[d]</span> <span style={{ color: '#64748B' }}>≥ 0</span> — Delivery delay in time buckets</div>
                  </div>
                </ModelSection>

                {/* Constraints */}
                <ModelSection
                  title="Constraints (6)"
                  expanded={expandedModelSections.has('constraints')}
                  onToggle={() => toggleModelSection('constraints')}
                >
                  <div className="space-y-2 text-xs" style={{ color: '#94A3B8' }}>
                    {[
                      { name: 'Flow Conservation', eq: '∑ in(v) x[a,r] − ∑ out(v) x[a,r] = Δ(v,r)' },
                      { name: 'Terminal Capacity', eq: '∑ᵣ ∑ₐ∈LoadedDep x[a,r] ≤ ResidualCap' },
                      { name: 'Section Capacity', eq: '∑ᵣ ∑ₐ∈Section(s,t) x[a,r] ≤ SectionCap' },
                      { name: 'Stock Compatibility', eq: 'x[a,r] = 0 if incompatible(stock(r), commodity(a))' },
                      { name: 'Servicing Turnaround', eq: 't_dep ≥ t_arr + MinServicing(term)' },
                      { name: 'Maintenance Windows', eq: 'x[a,r] = 0 during maintenance blackout' },
                    ].map((c, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 rounded" style={{ background: '#070B14' }}>
                        <CheckIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-medium" style={{ color: '#F1F5F9' }}>{c.name}</div>
                          <div className="font-mono text-[11px] mt-0.5" style={{ color: '#64748B' }}>{c.eq}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ModelSection>

                {/* Objective */}
                <ModelSection
                  title="Objective Function"
                  expanded={expandedModelSections.has('objective')}
                  onToggle={() => toggleModelSection('objective')}
                >
                  <div className="font-mono text-xs p-3 rounded" style={{ background: '#070B14', color: '#F59E0B' }}>
                    Minimize Z = w₁·∑ᵈ(uₐ·Pₐ) + w₂·∑ᵣₐ∈Eₘₚₜᵧ(x·dist) + w₃·∑ᵣₐ∈Dwell(x·hrs) + w₄·∑ᵈ(late·rate)
                  </div>
                  <div className="mt-2 space-y-1 text-[11px]" style={{ color: '#94A3B8' }}>
                    <div>w₁ (Unserved) = {weights.w_unserved} · w₂ (Empty km) = {weights.w_empty_km} · w₃ (Detention) = {weights.w_detention_hr} · w₄ (Lateness) = {weights.w_lateness}</div>
                  </div>
                </ModelSection>

                {/* Implementation Note */}
                <div className="mt-4 p-3 rounded-lg text-xs" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)', color: '#60A5FA' }}>
                  <strong>Implementation note:</strong> The current demo uses a TypeScript greedy heuristic for the repair phase.
                  The full OR-Tools CP-SAT formulation is implemented in <code className="font-mono">rust_core/solver_repair.py</code> and
                  can be integrated via subprocess for exact neighborhood repair.
                </div>
              </SectionCard>
            </div>
          )}

        </div>
      </main>

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t py-2 px-5 flex items-center justify-between text-[11px]" style={{ borderColor: '#1E2A3D', color: '#475569' }}>
        <span>PRJ 287 · Railway Rake Scheduling Research · Synthetic Benchmark Instance</span>
        <span className="font-mono">{benchmark.fleet.length} rakes · {benchmark.graph.arcs.length} arcs · {benchmark.graph.demands.length} demands</span>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function KpiCard({ label, value, sub, color, highlight, mono }: {
  label: string; value: string; sub: string; color: string; highlight?: boolean; mono?: boolean;
}) {
  return (
    <div className="p-3 rounded-xl transition-all" style={{
      background: highlight ? 'rgba(13,20,34,1)' : '#0D1422',
      border: `1px solid ${highlight ? 'rgba(52,211,153,0.2)' : '#1E2A3D'}`,
    }}>
      <div className="text-[11px] font-medium mb-1" style={{ color: '#64748B' }}>{label}</div>
      <div className={`text-xl font-bold ${mono ? 'font-mono' : ''}`} style={{ color, fontFamily: "'JetBrains Mono', monospace" }}>
        {value}
      </div>
      <div className="text-[10px] mt-1" style={{ color: '#475569' }}>{sub}</div>
    </div>
  );
}

function SectionCard({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl p-4" style={{ background: '#0D1422', border: '1px solid #1E2A3D' }}>
      <div className="flex items-center justify-between mb-3 pb-2 border-b" style={{ borderColor: '#162033' }}>
        <div>
          <h2 className="text-sm font-bold" style={{ color: '#F1F5F9' }}>{title}</h2>
          {subtitle && <p className="text-[11px] mt-0.5" style={{ color: '#64748B' }}>{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function PipelineStage({ label, status, detail, highlight }: {
  label: string; status: 'complete' | 'waiting' | 'error'; detail: string; highlight?: boolean;
}) {
  const stColor = status === 'complete' ? (highlight ? '#34D399' : '#F59E0B') : status === 'error' ? '#FB7185' : '#475569';
  const bgColor = status === 'complete' ? (highlight ? 'rgba(52,211,153,0.06)' : 'rgba(245,158,11,0.05)') : status === 'error' ? 'rgba(251,113,133,0.05)' : 'transparent';
  return (
    <div className="flex items-start gap-3 p-2.5 rounded-lg" style={{ background: bgColor, border: `1px solid ${status !== 'waiting' ? stColor + '33' : '#162033'}` }}>
      <div className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: stColor }} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold font-mono" style={{ color: stColor }}>{label}</div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: '#94A3B8' }}>{detail}</div>
      </div>
    </div>
  );
}

function PipelineArrow() {
  return (
    <div className="flex justify-center py-0.5">
      <div className="w-px h-4" style={{ background: '#1E2A3D' }} />
    </div>
  );
}

function DetailCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="p-2.5 rounded-lg" style={{ background: '#070B14', border: '1px solid #162033' }}>
      <div className="text-[10px] mb-0.5" style={{ color: '#64748B' }}>{label}</div>
      <div className="text-xs font-mono font-semibold" style={{ color: highlight ? '#34D399' : '#F1F5F9' }}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function ObjectiveBreakdown({ score }: { score: import('./types/rake_allocation').ObjectiveScore }) {
  const total = score.total_weighted_cost || 1;
  const items = [
    { label: 'Unserved Demand', value: score.unserved_penalty, color: '#FB7185' },
    { label: 'Delivery Lateness', value: score.lateness_penalty, color: '#FBBF24' },
    { label: 'Detention', value: score.detention_cost, color: '#60A5FA' },
    { label: 'Empty Repositioning', value: score.empty_km_cost, color: '#F59E0B' },
  ];
  return (
    <div className="space-y-3">
      {items.map(item => (
        <div key={item.label}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span style={{ color: '#94A3B8' }}>{item.label}</span>
            <span className="font-mono font-semibold" style={{ color: item.color }}>{fmtCost(item.value)}</span>
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: '#070B14' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, (item.value / total) * 100)}%`, background: item.color, opacity: 0.7 }}
            />
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between pt-2 border-t text-xs" style={{ borderColor: '#1E2A3D' }}>
        <span className="font-semibold" style={{ color: '#F1F5F9' }}>Total</span>
        <span className="font-mono font-bold" style={{ color: '#F1F5F9' }}>{fmtCost(total)}</span>
      </div>
    </div>
  );
}

function ConvergenceChart({ data, baselineCost }: { data: LnsIterationLog[]; baselineCost: number }) {
  if (data.length < 2) return null;

  const maxVal = Math.max(baselineCost, ...data.map(d => d.best_cost));
  const minVal = Math.min(...data.map(d => d.best_cost)) * 0.9;
  const range = maxVal - minVal || 1;
  const W = 700;
  const H = 180;
  const pad = { t: 10, b: 24, l: 55, r: 10 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;

  const pts = data.map((d, i) => ({
    x: pad.l + (i / (data.length - 1)) * cW,
    y: pad.t + (1 - (d.best_cost - minVal) / range) * cH,
  }));

  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  // Y axis labels
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    val: minVal + f * range,
    y: pad.t + (1 - f) * cH,
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: '200px' }}>
      {/* Grid lines */}
      {yLabels.map((yl, i) => (
        <g key={i}>
          <line x1={pad.l} y1={yl.y} x2={W - pad.r} y2={yl.y} stroke="#162033" strokeWidth="1" />
          <text x={pad.l - 6} y={yl.y + 3} textAnchor="end" fill="#475569" fontSize="8" fontFamily="JetBrains Mono, monospace">
            ₹{Math.round(yl.val).toLocaleString('en-IN')}
          </text>
        </g>
      ))}

      {/* Baseline reference */}
      <line
        x1={pad.l} y1={pad.t + (1 - (baselineCost - minVal) / range) * cH}
        x2={W - pad.r} y2={pad.t + (1 - (baselineCost - minVal) / range) * cH}
        stroke="#FB718533" strokeWidth="1" strokeDasharray="4,3"
      />
      <text
        x={W - pad.r} y={pad.t + (1 - (baselineCost - minVal) / range) * cH - 4}
        textAnchor="end" fill="#FB7185" fontSize="7" fontFamily="JetBrains Mono, monospace"
      >Baseline</text>

      {/* Best objective line */}
      <path d={pathD} fill="none" stroke="#34D399" strokeWidth="1.5" />

      {/* New best markers */}
      {data.map((d, i) => d.is_new_best && (
        <circle key={i} cx={pts[i].x} cy={pts[i].y} r="3" fill="#34D399" />
      ))}

      {/* Current best dot */}
      {pts.length > 0 && (
        <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="4" fill="#34D399" stroke="#070B14" strokeWidth="2" />
      )}

      {/* X axis labels */}
      <text x={pad.l} y={H - 4} fill="#475569" fontSize="8" fontFamily="JetBrains Mono, monospace">
        #{data[0]?.iteration || 1}
      </text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" fill="#475569" fontSize="8" fontFamily="JetBrains Mono, monospace">
        #{data[data.length - 1]?.iteration}
      </text>
    </svg>
  );
}

function ModelSection({ title, expanded, onToggle, children }: {
  title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium transition-all text-left"
        style={{ background: expanded ? '#121B2C' : '#070B14', border: '1px solid #162033', color: '#F1F5F9' }}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        {title}
      </button>
      {expanded && (
        <div className="mt-1 px-3 py-3 rounded-lg animate-slide-in" style={{ background: '#0D1422', border: '1px solid #162033' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Route summarization helper ──────────────────────────────────────────────
function summarizeRoute(path: number[], arcs: import('./types/rake_allocation').TimeExpandedArc[]): { type: string; label: string }[] {
  const segments: { type: string; label: string }[] = [];
  let dwellCount = 0;

  for (const aid of path) {
    const arc = arcs[aid];
    if (!arc) continue;

    if (arc.kind.type === 'LoadedMovement') {
      if (dwellCount > 0) { segments.push({ type: 'DWELL', label: `Dwell ×${dwellCount}` }); dwellCount = 0; }
      segments.push({
        type: 'LOADED',
        label: `${TERMINALS[arc.kind.origin_terminal]?.code}→${TERMINALS[arc.kind.dest_terminal]?.code}`,
      });
    } else if (arc.kind.type === 'EmptyRepositioning') {
      if (dwellCount > 0) { segments.push({ type: 'DWELL', label: `Dwell ×${dwellCount}` }); dwellCount = 0; }
      segments.push({
        type: 'EMPTY',
        label: `⟲${TERMINALS[arc.kind.origin_terminal]?.code}→${TERMINALS[arc.kind.dest_terminal]?.code}`,
      });
    } else if (arc.kind.type === 'ServicingTurnaround') {
      if (dwellCount > 0) { segments.push({ type: 'DWELL', label: `Dwell ×${dwellCount}` }); dwellCount = 0; }
      segments.push({ type: 'SERVICE', label: 'Service' });
    } else {
      dwellCount++;
    }
  }
  if (dwellCount > 0) segments.push({ type: 'DWELL', label: `Dwell ×${dwellCount}` });

  // Compact consecutive dwells that are not between meaningful arcs
  if (segments.length === 1 && segments[0].type === 'DWELL') return [];
  return segments;
}
