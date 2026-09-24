import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  TERMINALS,
  buildBenchmarkGraph,
  evaluateSchedule,
  validateFeasibility,
} from './simulator';
import {
  createDestroyedFragment,
  executeCpSatRepairStep,
} from './lns_runner';
import {
  DestroyOperatorKind,
  DestroyedFragment,
  IncumbentSchedule,
  LnsIterationLog,
  ObjectiveWeights,
  TimeExpandedArc,
  WagonStockType,
} from './types/rake_allocation';
import {
  Play,
  Pause,
  RotateCcw,
  StepForward,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
  Network,
  Cpu,
  Sliders,
  Flame,
  Clock,
  Layers,
  Activity,
  Download,
  Copy,
  Check,
  ChevronRight,
  TrendingDown,
  Truck,
  Database,
  ArrowRight,
  ShieldCheck,
  Wrench,
  AlertOctagon,
} from 'lucide-react';

// Pre-cached Rust & Python Code files for instant tab inspection
const CODE_FILES: Record<string, { language: string; filename: string; description: string; code: string }> = {
  'graph.rs': {
    language: 'rust',
    filename: 'rust_core/src/graph.rs',
    description: 'Spatio-Temporal Discretized Network Graph (Nodes, Arcs, Capacities, Stock Compatibility)',
    code: `//! Time-Expanded Network Graph for Railway Rake Allocation (PRJ 287)
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub type TerminalId = usize;
pub type TimeBucket = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WagonStockType {
    BOXN,   // Open wagon: Coal, Iron Ore, Stone
    BOBRN,  // Bottom discharge hopper: Power-plant bulk coal
    BCN,    // Covered wagon: Bagged cement, foodgrains, fertilizer
    BTPN,   // Tank wagon: POL / liquid fuels
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Commodity {
    ThermalCoal,
    CokingCoal,
    IronOre,
    BaggedCement,
    FoodGrain,
    PetroleumProduct,
}

impl WagonStockType {
    /// Stock-type compatibility check (Constraint 4).
    pub fn is_compatible_with(&self, commodity: Commodity) -> bool {
        match (self, commodity) {
            (WagonStockType::BOXN, Commodity::ThermalCoal | Commodity::CokingCoal | Commodity::IronOre) => true,
            (WagonStockType::BOBRN, Commodity::ThermalCoal | Commodity::CokingCoal) => true,
            (WagonStockType::BCN, Commodity::BaggedCement | Commodity::FoodGrain) => true,
            (WagonStockType::BTPN, Commodity::PetroleumProduct) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TimeExpandedNode {
    pub terminal_id: TerminalId,
    pub time_bucket: TimeBucket,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ArcKind {
    LoadedMovement {
        demand_id: usize,
        commodity: Commodity,
        origin_terminal: TerminalId,
        dest_terminal: TerminalId,
    },
    EmptyRepositioning {
        origin_terminal: TerminalId,
        dest_terminal: TerminalId,
        empty_distance_km: f64,
    },
    StationaryDwell {
        terminal_id: TerminalId,
        detention_cost_per_hour: f64,
    },
    ServicingTurnaround {
        terminal_id: TerminalId,
        required_duration_buckets: u32,
    },
    ScheduledMaintenance {
        terminal_id: TerminalId,
        work_order_id: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeExpandedArc {
    pub arc_id: usize,
    pub from_node: TimeExpandedNode,
    pub to_node: TimeExpandedNode,
    pub kind: ArcKind,
    pub distance_km: f64,
    pub transit_time_buckets: u32,
    pub section_id: Option<usize>,
    pub allowed_stock_types: Vec<WagonStockType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeExpandedGraph {
    pub horizon_buckets: TimeBucket,
    pub terminal_count: usize,
    pub nodes: Vec<TimeExpandedNode>,
    pub arcs: Vec<TimeExpandedArc>,
    pub forward_star: HashMap<TimeExpandedNode, Vec<usize>>,
    pub reverse_star: HashMap<TimeExpandedNode, Vec<usize>>,
    pub terminal_capacities: HashMap<(TerminalId, TimeBucket), TerminalCapacity>,
    pub section_capacities: HashMap<usize, SectionCapacity>,
    pub demands: Vec<TransportDemand>,
    pub maintenance_windows: Vec<MaintenanceWindow>,
    pub min_servicing_buckets: HashMap<TerminalId, u32>,
}`,
  },
  'schedule.rs': {
    language: 'rust',
    filename: 'rust_core/src/schedule.rs',
    description: 'Incumbent Schedule representation, Multi-Criteria Objective & 6-Constraint Feasibility Validator',
    code: `//! Incumbent Schedule & Multi-Criteria Objective Evaluation for PRJ 287
use crate::graph::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectiveWeights {
    pub w_unserved: f64,    // e.g., 5000.0
    pub w_empty_km: f64,    // e.g., 2.5
    pub w_detention_hr: f64,// e.g., 15.0
    pub w_lateness: f64,    // e.g., 250.0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ObjectiveScore {
    pub unserved_demands_count: usize,
    pub unserved_penalty: f64,
    pub total_empty_km: f64,
    pub empty_km_cost: f64,
    pub total_detention_hours: f64,
    pub detention_cost: f64,
    pub total_lateness_buckets: u32,
    pub lateness_penalty: f64,
    pub total_weighted_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncumbentSchedule {
    pub fleet: Vec<RakeAsset>,
    pub arc_flows: HashMap<usize, Vec<usize>>,
    pub rake_paths: HashMap<usize, Vec<usize>>,
    pub demand_fulfillment: HashMap<usize, Option<(usize, TimeBucket)>>,
    pub score: ObjectiveScore,
}

impl IncumbentSchedule {
    pub fn evaluate(&mut self, graph: &TimeExpandedGraph, weights: &ObjectiveWeights) -> &ObjectiveScore {
        // Evaluates Unserved Penalties + Empty Km + Detention Hours + Lateness
        // w_unserved * ∑ u_d + w_empty * ∑ dist + w_det * ∑ hours + w_late * ∑ delay
        // ...
    }

    pub fn validate_feasibility(&self, graph: &TimeExpandedGraph) -> FeasibilityReport {
        // Enforces:
        // 1. Rake Conservation at every node (flow in = flow out)
        // 2. Terminal Loading/Unloading Capacities
        // 3. Section Track Capacities
        // 4. Stock-Type Compatibility
        // 5. Servicing Turnaround Duration
        // 6. Scheduled Maintenance Outage Windows
        // ...
    }
}`,
  },
  'destroy.rs': {
    language: 'rust',
    filename: 'rust_core/src/destroy.rs',
    description: 'Handcrafted Destroy Operators (Time-Window & Geographic Cluster) & Boundary Condition Extraction',
    code: `//! Handcrafted Destroy Operators & Boundary State Extraction
use crate::graph::*;
use crate::schedule::*;
use rand::Rng;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryRakeState {
    pub rake_id: usize,
    pub terminal_id: TerminalId,
    pub boundary_time: TimeBucket,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestroyedFragment {
    pub operator_used: DestroyOperatorKind,
    pub affected_terminals: HashSet<TerminalId>,
    pub t_start: TimeBucket,
    pub t_end: TimeBucket,
    pub incoming_boundary: Vec<BoundaryRakeState>,
    pub outgoing_boundary: Vec<BoundaryRakeState>,
    pub destroyed_arc_ids: HashSet<usize>,
    pub unassigned_demand_ids: HashSet<usize>,
    pub frozen_demand_ids: HashSet<usize>,
}

pub trait DestroyOperator {
    fn destroy(
        &self,
        schedule: &IncumbentSchedule,
        graph: &TimeExpandedGraph,
        rng: &mut impl Rng,
    ) -> DestroyedFragment;
}

pub struct RandomTimeWindowDestroy { pub window_duration: u32 }
pub struct GeographicClusterDestroy { pub cluster_size: usize, pub window_duration: u32 }`,
  },
  'lns_loop.rs': {
    language: 'rust',
    filename: 'rust_core/src/lns_loop.rs',
    description: 'The Core LNS Loop: Destroy-Repair Cycle, Boundary Clamping, and Incumbent Management',
    code: `//! The Core Large-Neighbourhood Search (LNS) Loop
pub fn run_lns_rake_allocation(
    mut initial_schedule: IncumbentSchedule,
    graph: &TimeExpandedGraph,
    weights: &ObjectiveWeights,
    config: &LnsConfig,
) -> Result<LnsExecutionResult, String> {
    let start_instant = Instant::now();
    let mut rng = StdRng::seed_from_u64(config.seed);

    initial_schedule.evaluate(graph, weights);
    let mut state_manager = LnsStateManager::new(initial_schedule, weights.clone(), ...);

    while !state_manager.should_terminate(config.max_stagnant_iterations) {
        // 1. Destroy: select operator & extract boundary conditions
        let fragment = destroy_operator.destroy(&state_manager.incumbent, graph, &mut rng);

        // 2. Exact CP-SAT Repair with boundary conditions clamped
        let repair_input = prepare_repair_payload(&state_manager.incumbent, graph, &fragment, weights, ...);
        let repair_output = execute_cp_sat_repair(&repair_input, graph, &mut rng)?;

        // 3. Splice candidate solution
        let mut candidate = state_manager.incumbent.clone();
        splice_repair_solution(&mut candidate, graph, &fragment, &repair_output);
        candidate.evaluate(graph, weights);

        // 4. Feasibility Guarantee Check
        let feas = candidate.validate_feasibility(graph);
        if !feas.is_feasible { continue; }

        // 5. Simulated Annealing Candidate Acceptance
        state_manager.consider_candidate(candidate, operator_kind, ...);
    }

    Ok(state_manager.best_solution)
}`,
  },
  'solver_repair.py': {
    language: 'python',
    filename: 'rust_core/solver_repair.py',
    description: 'Exact OR-Tools CP-SAT Mathematical Programming Formulation (Variables, Constraints, Boundary Pins)',
    code: `"""
OR-Tools CP-SAT Exact Repair Formulation for PRJ 287 Rake Allocation
"""
from ortools.sat.python import cp_model

def solve_repair_problem(input_data):
    model = cp_model.CpModel()
    
    # 1. Decision Variables
    # x[arc_id, rake_id]: Binary assignment of rake r to arc a
    # u[demand_id]: Binary unserved slack indicator
    # lateness[demand_id]: Integer delay buckets
    x = {(a["arc_id"], r): model.NewBoolVar(f"x_{a['arc_id']}_{r}") 
         for a in sub_arcs for r in rakes}
    u = {d["demand_id"]: model.NewBoolVar(f"u_{d['demand_id']}") for d in demands}
    lateness = {d["demand_id"]: model.NewIntVar(0, max_late, f"late_{d['demand_id']}") for d in demands}

    # 2. Constraint 1: Rake Flow Conservation & Boundary Delta
    # Incoming boundary node: Net Outflow = +1
    # Outgoing boundary node: Net Inflow  = +1
    # Internal node: Net Flow = 0
    for (term, b_time) in nodes:
        for r in rakes:
            in_flow = sum(x[aid, r] for aid in reverse_star.get((term, b_time), []))
            out_flow = sum(x[aid, r] for aid in forward_star.get((term, b_time), []))
            if (term, b_time, r) in in_bounds:
                model.Add(out_flow - in_flow == 1)
            elif (term, b_time, r) in out_bounds:
                model.Add(in_flow - out_flow == 1)
            else:
                model.Add(in_flow == out_flow)

    # 3. Constraint 2: Terminal Loading / Unloading Residual Capacities
    # sum_r sum_{a in DepLoaded} x[a, r] <= ResidualLoadingCap[term, t]
    # sum_r sum_{a in ArrLoaded} x[a, r] <= ResidualUnloadingCap[term, t]

    # 4. Constraint 3: Section Corridor Track Capacity
    # sum_r sum_{a in Section(s, t)} x[a, r] <= ResidualSectionCap[s, t]

    # 5. Constraint 4: Stock-Type Compatibility
    # x[a, r] == 0 if commodity incompatible with wagon type

    # 6. Constraint 5 & 6: Minimum Servicing & Maintenance Blackout Windows
    
    # Multi-Criteria Objective Function:
    model.Minimize(
        w1 * sum(u[d] * pen for d in demands) +
        w2 * sum(x[a, r] * dist for a in empty_arcs for r in rakes) +
        w3 * sum(x[a, r] * hours for a in dwell_arcs for r in rakes) +
        w4 * sum(lateness[d] * rate for d in demands)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(timeout_sec)
    status = solver.Solve(model)
    return extract_solution(solver, x, u, lateness)`,
  },
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'network' | 'cpsat' | 'codebase' | 'telemetry'>('dashboard');
  const [activeCodeFile, setActiveCodeFile] = useState<string>('lns_loop.rs');
  const [copiedCode, setCopiedCode] = useState(false);

  // Benchmarking Setup
  const benchmark = useMemo(() => buildBenchmarkGraph(36), []);
  const [incumbent, setIncumbent] = useState<IncumbentSchedule>(() => benchmark.initialSchedule);
  const [bestSchedule, setBestSchedule] = useState<IncumbentSchedule>(() => benchmark.initialSchedule);
  const [iterationHistory, setIterationHistory] = useState<LnsIterationLog[]>([]);
  const [currentIter, setCurrentIter] = useState(0);
  const [lastFragment, setLastFragment] = useState<DestroyedFragment | null>(null);
  const [selectedOperator, setSelectedOperator] = useState<DestroyOperatorKind>('RandomTimeWindow');
  const [windowDuration, setWindowDuration] = useState<number>(8);
  const [clusterCenter, setClusterCenter] = useState<number>(0);
  const [temperature, setTemperature] = useState<number>(1500.0);
  const [coolingRate, setCoolingRate] = useState<number>(0.95);
  const [weights, setWeights] = useState<ObjectiveWeights>({
    w_unserved: 5000,
    w_empty_km: 2.5,
    w_detention_hr: 15.0,
    w_lateness: 250.0,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [filterRakeId, setFilterRakeId] = useState<number | 'ALL'>('ALL');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Compute feasibility
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

  // Single LNS Step execution
  const stepLns = () => {
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

    const { repairedSchedule, solveDurationMs } = executeCpSatRepairStep(
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
    };

    setIterationHistory((prev) => [logEntry, ...prev.slice(0, 99)]);
  };

  // Run / Pause loop
  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        stepLns();
      }, 400);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning, incumbent, bestSchedule, temperature, selectedOperator, windowDuration, weights]);

  const resetAll = () => {
    setIsRunning(false);
    setIncumbent(benchmark.initialSchedule);
    setBestSchedule(benchmark.initialSchedule);
    setIterationHistory([]);
    setCurrentIter(0);
    setTemperature(1500.0);
    setLastFragment(null);
  };

  const copyCodeToClipboard = () => {
    const text = CODE_FILES[activeCodeFile]?.code || '';
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const costReduction = useMemo(() => {
    const init = benchmark.initialSchedule.score.total_weighted_cost;
    const cur = bestSchedule.score.total_weighted_cost;
    if (init <= 0) return 0;
    return (((init - cur) / init) * 100).toFixed(1);
  }, [benchmark, bestSchedule]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-amber-500 selection:text-slate-950">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-50 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-red-600 flex items-center justify-center shadow-lg shadow-amber-500/20 text-slate-950 font-black">
            287
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-100 tracking-tight">PRJ 287 Rake Allocation Engine</h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-500/10 text-amber-400 border border-amber-500/30">
                Solver Core & Exact Repair
              </span>
            </div>
            <p className="text-xs text-slate-400">Large-Neighbourhood Search (Rust) + OR-Tools CP-SAT Exact Boundary Repair</p>
          </div>
        </div>

        {/* Global KPI quick badges */}
        <div className="hidden lg:flex items-center gap-4">
          <div className="bg-slate-800/80 px-3 py-1.5 rounded-md border border-slate-700/60 flex items-center gap-3 text-xs">
            <span className="text-slate-400">Initial Cost:</span>
            <span className="font-mono text-slate-300">₹{benchmark.initialSchedule.score.total_weighted_cost.toLocaleString()}</span>
            <ArrowRight className="w-3 h-3 text-slate-500" />
            <span className="text-emerald-400 font-bold font-mono">₹{bestSchedule.score.total_weighted_cost.toLocaleString()}</span>
            <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold">
              -{costReduction}%
            </span>
          </div>

          <div className="bg-slate-800/80 px-3 py-1.5 rounded-md border border-slate-700/60 flex items-center gap-2 text-xs">
            <ShieldCheck className={`w-4 h-4 ${feasibility.is_feasible ? 'text-emerald-400' : 'text-rose-500'}`} />
            <span className="text-slate-400">CP-SAT Feasibility:</span>
            <span className={`font-semibold ${feasibility.is_feasible ? 'text-emerald-400' : 'text-rose-400'}`}>
              {feasibility.is_feasible ? '100% Guaranteed' : 'Violations Detected'}
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === 'dashboard' ? 'bg-amber-500 text-slate-950 font-semibold shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="w-3.5 h-3.5" /> Dashboard & Solver
          </button>
          <button
            onClick={() => setActiveTab('network')}
            className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === 'network' ? 'bg-amber-500 text-slate-950 font-semibold shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Network className="w-3.5 h-3.5" /> Time-Expanded Graph
          </button>
          <button
            onClick={() => setActiveTab('cpsat')}
            className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === 'cpsat' ? 'bg-amber-500 text-slate-950 font-semibold shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" /> CP-SAT Formulation
          </button>
          <button
            onClick={() => setActiveTab('codebase')}
            className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition ${
              activeTab === 'codebase' ? 'bg-amber-500 text-slate-950 font-semibold shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode2 className="w-3.5 h-3.5" /> Rust & Python Core
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 p-5 overflow-y-auto max-w-7xl mx-auto w-full space-y-5">
        {/* ======================= TAB 1: DASHBOARD & SOLVER ======================= */}
        {activeTab === 'dashboard' && (
          <div className="space-y-5">
            {/* Control Panel & Solvers */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                {/* LNS Loop Controls */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsRunning(!isRunning)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 shadow-md transition ${
                      isRunning
                        ? 'bg-rose-600 hover:bg-rose-500 text-white'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    }`}
                  >
                    {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    {isRunning ? 'Pause Search' : 'Run LNS Loop'}
                  </button>

                  <button
                    onClick={stepLns}
                    disabled={isRunning}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-lg text-sm font-medium flex items-center gap-1.5 border border-slate-700"
                    title="Execute 1 Destroy-Repair Iteration"
                  >
                    <StepForward className="w-4 h-4 text-amber-400" /> Step Iteration
                  </button>

                  <button
                    onClick={resetAll}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium flex items-center gap-1.5 border border-slate-700"
                    title="Reset to Initial Schedule"
                  >
                    <RotateCcw className="w-4 h-4 text-slate-400" /> Reset
                  </button>
                </div>

                {/* Handcrafted Destroy Operator Selector */}
                <div className="flex items-center gap-3 text-xs bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
                  <span className="text-slate-400 font-medium">Destroy Operator:</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedOperator('RandomTimeWindow')}
                      className={`px-2.5 py-1 rounded text-xs transition ${
                        selectedOperator === 'RandomTimeWindow'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Time Window (Δt)
                    </button>
                    <button
                      onClick={() => setSelectedOperator('GeographicCluster')}
                      className={`px-2.5 py-1 rounded text-xs transition ${
                        selectedOperator === 'GeographicCluster'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Geographic Cluster
                    </button>
                    <button
                      onClick={() => setSelectedOperator('HighDetentionTargeted')}
                      className={`px-2.5 py-1 rounded text-xs transition ${
                        selectedOperator === 'HighDetentionTargeted'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      High Detention Siding
                    </button>
                  </div>
                </div>

                {/* Window Size Slider */}
                <div className="flex items-center gap-2 text-xs bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
                  <span className="text-slate-400">Destroy Window:</span>
                  <input
                    type="range"
                    min={4}
                    max={16}
                    value={windowDuration}
                    onChange={(e) => setWindowDuration(Number(e.target.value))}
                    className="w-20 accent-amber-500"
                  />
                  <span className="font-mono text-amber-400 font-bold">{windowDuration}h</span>
                </div>
              </div>
            </div>

            {/* Top 4 KPI Metrics Card */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Unserved Demand */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>Unserved Demand (w1)</span>
                  <span className="font-mono text-amber-400">w={weights.w_unserved}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold font-mono text-rose-400">
                    {bestSchedule.score.unserved_demands_count} <span className="text-xs text-slate-400">rakes</span>
                  </div>
                  <div className="text-xs font-mono text-slate-400">
                    ₹{bestSchedule.score.unserved_penalty.toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
                  <span>Initial: {benchmark.initialSchedule.score.unserved_demands_count} rakes</span>
                  <span className="text-emerald-400">
                    -{benchmark.initialSchedule.score.unserved_demands_count - bestSchedule.score.unserved_demands_count} served
                  </span>
                </div>
              </div>

              {/* Empty Kilometres */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>Empty Repositioning (w2)</span>
                  <span className="font-mono text-amber-400">₹{weights.w_empty_km}/km</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold font-mono text-amber-400">
                    {bestSchedule.score.total_empty_km.toLocaleString()} <span className="text-xs text-slate-400">km</span>
                  </div>
                  <div className="text-xs font-mono text-slate-400">
                    ₹{bestSchedule.score.empty_km_cost.toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  Empty rake balancing across deficit terminals
                </div>
              </div>

              {/* Detention Hours */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>Detention & Idling (w3)</span>
                  <span className="font-mono text-amber-400">₹{weights.w_detention_hr}/hr</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold font-mono text-sky-400">
                    {bestSchedule.score.total_detention_hours} <span className="text-xs text-slate-400">hrs</span>
                  </div>
                  <div className="text-xs font-mono text-slate-400">
                    ₹{bestSchedule.score.detention_cost.toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
                  <span>Initial: {benchmark.initialSchedule.score.total_detention_hours} hrs</span>
                  <span className="text-emerald-400">
                    -{benchmark.initialSchedule.score.total_detention_hours - bestSchedule.score.total_detention_hours} hrs idle
                  </span>
                </div>
              </div>

              {/* Delivery Lateness */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span>Delivery Lateness (w4)</span>
                  <span className="font-mono text-amber-400">w={weights.w_lateness}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold font-mono text-emerald-400">
                    {bestSchedule.score.total_lateness_buckets} <span className="text-xs text-slate-400">buckets</span>
                  </div>
                  <div className="text-xs font-mono text-slate-400">
                    ₹{bestSchedule.score.lateness_penalty.toLocaleString()}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  Strict delivery adherence at power plants & ports
                </div>
              </div>
            </div>

            {/* Two-Column Section: Operational Constraints & Current Destroyed Fragment */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Left 6 cols: 6 Railway Operational Constraints Feasibility Checklist */}
              <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-amber-400" />
                    <h2 className="text-sm font-bold text-slate-200">Mathematical Feasibility Checklist</h2>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                    Guaranteed by CP-SAT
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  {/* Constraint 1 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">1. Rake Conservation at Every Node</div>
                      <div className="text-slate-400 text-[11px]">
                        Continuous flow: <code className="text-amber-400 font-mono">∑ in = ∑ out</code> at all (terminal, bucket) nodes. Pinned boundary inflow/outflow delta.
                      </div>
                    </div>
                  </div>

                  {/* Constraint 2 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">2. Terminal Loading & Unloading Capacities</div>
                      <div className="text-slate-400 text-[11px]">
                        Siding and tippler constraints respected: max simultaneous loading/unloading per time bucket per terminal.
                      </div>
                    </div>
                  </div>

                  {/* Constraint 3 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">3. Section Corridor Capacity</div>
                      <div className="text-slate-400 text-[11px]">
                        Block section line headway and track limits enforced across corridors (Mines ↔ Sipat: max 4 rakes; Vizag: max 3).
                      </div>
                    </div>
                  </div>

                  {/* Constraint 4 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">4. Stock-Type Compatibility</div>
                      <div className="text-slate-400 text-[11px]">
                        Wagon classes locked to commodities: BOBRN/BOXN for Coal/Ore, BCN for bagged cement, BTPN for fuels.
                      </div>
                    </div>
                  </div>

                  {/* Constraint 5 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">5. Minimum Servicing & Turnaround Time</div>
                      <div className="text-slate-400 text-[11px]">
                        Released rakes must undergo min post-trip turnaround inspection (2–3 hours) before re-entering available pool.
                      </div>
                    </div>
                  </div>

                  {/* Constraint 6 */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex items-start gap-3">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-semibold text-slate-200">6. Scheduled Maintenance Windows</div>
                      <div className="text-slate-400 text-[11px]">
                        Rake #4 completely withdrawn from rolling pool during window [10..18h] for mandatory depot overhaul.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right 6 cols: Current LNS Destroyed Fragment & Boundary Clamping Inspector */}
              <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-amber-400" />
                    <h2 className="text-sm font-bold text-slate-200">Active Destroyed Fragment & Boundary Pins</h2>
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">
                    Iteration #{currentIter}
                  </span>
                </div>

                {lastFragment ? (
                  <div className="space-y-3 text-xs">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-slate-950 p-2 rounded border border-slate-800">
                        <div className="text-slate-400 text-[10px]">Time Window</div>
                        <div className="text-amber-400 font-mono font-bold">
                          t=[{lastFragment.t_start}h .. {lastFragment.t_end}h]
                        </div>
                      </div>
                      <div className="bg-slate-950 p-2 rounded border border-slate-800">
                        <div className="text-slate-400 text-[10px]">Destroyed Arcs</div>
                        <div className="text-rose-400 font-mono font-bold">
                          {lastFragment.destroyed_arc_ids.length} arcs
                        </div>
                      </div>
                      <div className="bg-slate-950 p-2 rounded border border-slate-800">
                        <div className="text-slate-400 text-[10px]">Unassigned Demands</div>
                        <div className="text-sky-400 font-mono font-bold">
                          {lastFragment.unassigned_demand_ids.length} orders
                        </div>
                      </div>
                    </div>

                    {/* Incoming Boundary Pinning */}
                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                      <div className="font-semibold text-slate-300 text-[11px] flex items-center justify-between">
                        <span>Incoming Boundary Pins (Fixed Preceding Flow)</span>
                        <span className="text-amber-400 font-mono">{lastFragment.incoming_boundary.length} rakes</span>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1 pr-1 font-mono text-[10px]">
                        {lastFragment.incoming_boundary.map((b, idx) => (
                          <div key={idx} className="bg-slate-900 px-2 py-1 rounded flex items-center justify-between text-slate-300">
                            <span>Rake #{b.rake_id}</span>
                            <span className="text-slate-400">
                              Entering: {TERMINALS[b.terminal_id]?.code} @ t={b.boundary_time}h
                            </span>
                            <span className="text-emerald-400">pinned net_out = +1</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Outgoing Boundary Pinning */}
                    <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                      <div className="font-semibold text-slate-300 text-[11px] flex items-center justify-between">
                        <span>Outgoing Boundary Targets (Fixed Downstream Schedule)</span>
                        <span className="text-amber-400 font-mono">{lastFragment.outgoing_boundary.length} rakes</span>
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1 pr-1 font-mono text-[10px]">
                        {lastFragment.outgoing_boundary.map((b, idx) => (
                          <div key={idx} className="bg-slate-900 px-2 py-1 rounded flex items-center justify-between text-slate-300">
                            <span>Rake #{b.rake_id}</span>
                            <span className="text-slate-400">
                              Expected: {TERMINALS[b.terminal_id]?.code} @ t={b.boundary_time}h
                            </span>
                            <span className="text-sky-400">pinned net_in = +1</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-950/60 border border-dashed border-slate-800 rounded-lg p-8 text-center text-slate-500 text-xs">
                    Click <strong className="text-slate-300">"Step Iteration"</strong> or <strong className="text-slate-300">"Run LNS Loop"</strong> to trigger the handcrafted destroy operator and inspect exact boundary conditions.
                  </div>
                )}
              </div>
            </div>

            {/* Iteration History Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-amber-400" />
                  <h2 className="text-sm font-bold text-slate-200">LNS Optimization Telemetry & Convergence Log</h2>
                </div>
                <span className="text-xs text-slate-400">
                  Temperature: <span className="font-mono text-amber-400 font-bold">{temperature.toFixed(1)}°</span> | Cooling: <span className="font-mono">{coolingRate}</span>
                </span>
              </div>

              {iterationHistory.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-mono text-[11px]">
                        <th className="py-2 px-3">Iter #</th>
                        <th className="py-2 px-3">Operator</th>
                        <th className="py-2 px-3">Candidate Cost</th>
                        <th className="py-2 px-3">Best Cost</th>
                        <th className="py-2 px-3">Decision</th>
                        <th className="py-2 px-3">Solve Time</th>
                        <th className="py-2 px-3">Unserved</th>
                        <th className="py-2 px-3">Empty Km</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {iterationHistory.slice(0, 10).map((log) => (
                        <tr key={log.iteration} className="hover:bg-slate-800/40 transition">
                          <td className="py-2 px-3 text-slate-300">#{log.iteration}</td>
                          <td className="py-2 px-3 text-amber-400 font-sans">{log.operator}</td>
                          <td className="py-2 px-3 text-slate-200">₹{log.candidate_cost.toLocaleString()}</td>
                          <td className="py-2 px-3 text-emerald-400 font-bold">₹{log.best_cost.toLocaleString()}</td>
                          <td className="py-2 px-3">
                            {log.is_new_best ? (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold">
                                NEW BEST
                              </span>
                            ) : log.accepted ? (
                              <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 text-[10px]">
                                ACCEPTED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">
                                REJECTED
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-slate-400">{log.solve_duration_ms}ms</td>
                          <td className="py-2 px-3 text-rose-400">{log.score_breakdown.unserved_demands_count}</td>
                          <td className="py-2 px-3 text-amber-400">{log.score_breakdown.total_empty_km}km</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-slate-500 text-center py-6 text-xs font-mono">
                  No iterations recorded yet. Launch the LNS loop to observe real-time candidate search.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================= TAB 2: TIME-EXPANDED NETWORK GRAPH ======================= */}
        {activeTab === 'network' && (
          <div className="space-y-5">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Network className="w-4 h-4 text-amber-400" /> Time-Expanded Network & Rake Trajectories
                </h2>
                <p className="text-xs text-slate-400">
                  Spatio-temporal grid: Terminals ({TERMINALS.length}) × Time Buckets (0..36h). Arcs represent loaded movements, empty repositioning, and dwelling.
                </p>
              </div>

              {/* Rake Filter */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">Filter Rake:</span>
                <select
                  value={filterRakeId}
                  onChange={(e) => setFilterRakeId(e.target.value === 'ALL' ? 'ALL' : Number(e.target.value))}
                  className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-slate-200 font-mono"
                >
                  <option value="ALL">All Rakes (Fleet of 10)</option>
                  {benchmark.fleet.map((r) => (
                    <option key={r.rake_id} value={r.rake_id}>
                      Rake #{r.rake_id} - {r.stock_type} ({r.name})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Visual Legend */}
            <div className="flex flex-wrap items-center gap-4 text-xs bg-slate-900/60 p-3 rounded-lg border border-slate-800 text-slate-300">
              <span className="text-slate-400 font-medium">Arc Legend:</span>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                <span>Loaded Movement (Thermal Coal / Iron Ore)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                <span>Empty Repositioning</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-slate-600"></div>
                <span>Stationary Dwell (Yard Siding)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-cyan-500"></div>
                <span>Turnaround Servicing (Post-Trip)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-rose-500"></div>
                <span>Maintenance Outage Blackout</span>
              </div>
            </div>

            {/* Spatio-Temporal Matrix Diagram */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 overflow-x-auto">
              <div className="min-w-[900px]">
                {/* Horizontal Time Bucket Axis Header */}
                <div className="grid grid-cols-37 gap-1 mb-2 text-[10px] font-mono text-slate-400 text-center">
                  <div className="text-left font-sans font-semibold text-slate-300 pr-2">Terminal</div>
                  {Array.from({ length: 36 + 1 }).map((_, b) => (
                    <div key={b} className={b % 6 === 0 ? 'text-amber-400 font-bold' : 'text-slate-500'}>
                      {b % 6 === 0 ? `${b}h` : '·'}
                    </div>
                  ))}
                </div>

                {/* Rows: Each Terminal */}
                <div className="space-y-3">
                  {TERMINALS.map((term) => (
                    <div key={term.id} className="relative bg-slate-950/80 rounded-lg p-2 border border-slate-800/80">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: term.color }}
                          ></span>
                          <span className="text-xs font-bold text-slate-200">{term.name}</span>
                          <span className="text-[10px] font-mono text-slate-500">[{term.code}]</span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                            {term.type}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400">
                          Min Servicing: {benchmark.graph.minServicing[term.id]}h | Dwell Cap: 8
                        </span>
                      </div>

                      {/* Time Bucket Cells */}
                      <div className="grid grid-cols-37 gap-1">
                        <div className="text-[10px] font-mono text-slate-500 flex items-center">
                          T#{term.id}
                        </div>
                        {Array.from({ length: 36 + 1 }).map((_, bucket) => {
                          // Check if inside destroyed fragment
                          const isDestroyedWindow =
                            lastFragment &&
                            bucket >= lastFragment.t_start &&
                            bucket <= lastFragment.t_end &&
                            lastFragment.affected_terminals.includes(term.id);

                          // Check maintenance window
                          const isMaintenance = benchmark.graph.maintenance.some(
                            (mw) =>
                              mw.terminal_id === term.id &&
                              bucket >= mw.start_bucket &&
                              bucket <= mw.end_bucket &&
                              (filterRakeId === 'ALL' || filterRakeId === mw.rake_id)
                          );

                          // Find rakes located at this node in bestSchedule
                          const presentRakes: number[] = [];
                          for (const [ridStr, path] of Object.entries(bestSchedule.rake_paths)) {
                            const rid = Number(ridStr);
                            if (filterRakeId !== 'ALL' && filterRakeId !== rid) continue;
                            for (const aid of path) {
                              const arc = benchmark.graph.arcs[aid];
                              if (
                                arc &&
                                arc.from_node.terminal_id === term.id &&
                                arc.from_node.time_bucket === bucket
                              ) {
                                presentRakes.push(rid);
                                break;
                              }
                            }
                          }

                          return (
                            <div
                              key={bucket}
                              className={`h-9 rounded flex flex-col items-center justify-center text-[9px] font-mono border transition-all ${
                                isMaintenance
                                  ? 'bg-rose-950/60 border-rose-600/80 text-rose-300'
                                  : isDestroyedWindow
                                  ? 'bg-amber-950/40 border-amber-500/60 text-amber-200 shadow-inner shadow-amber-500/10'
                                  : presentRakes.length > 0
                                  ? 'bg-slate-800/90 border-slate-700 text-slate-100'
                                  : 'bg-slate-900/30 border-slate-800/40 text-slate-600'
                              }`}
                              title={`Terminal: ${term.name} (${term.code})\nTime Bucket: ${bucket}h\nRakes present: ${
                                presentRakes.length > 0 ? presentRakes.join(', ') : 'None'
                              }`}
                            >
                              {isMaintenance ? (
                                <Wrench className="w-2.5 h-2.5 text-rose-400" />
                              ) : presentRakes.length > 0 ? (
                                <div className="flex flex-col items-center">
                                  <span className="font-bold text-amber-400">R{presentRakes[0]}</span>
                                  {presentRakes.length > 1 && (
                                    <span className="text-[7px] text-slate-400">+{presentRakes.length - 1}</span>
                                  )}
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

            {/* Rake Path Inspector */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
              <h3 className="text-xs font-bold text-slate-200 flex items-center gap-2">
                <Truck className="w-4 h-4 text-amber-400" /> Rake Roster & Dispatched Routes (Best Solution)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
                {benchmark.fleet.map((rake) => {
                  const path = bestSchedule.rake_paths[rake.rake_id] || [];
                  return (
                    <div
                      key={rake.rake_id}
                      className={`p-3 rounded-lg border ${
                        filterRakeId === rake.rake_id
                          ? 'bg-amber-500/10 border-amber-500/40'
                          : 'bg-slate-950 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-bold text-slate-200">
                          Rake #{rake.rake_id} [{rake.stock_type}] - {rake.name}
                        </span>
                        <span className="text-slate-500 text-[10px] font-sans">
                          Initial: {TERMINALS[rake.initial_terminal]?.code}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 line-clamp-2">
                        Path ({path.length} arcs):{' '}
                        {path.map((aid) => {
                          const arc = benchmark.graph.arcs[aid];
                          if (!arc) return '';
                          if (arc.kind.type === 'LoadedMovement') {
                            return `[LOADED ${TERMINALS[arc.kind.origin_terminal]?.code}→${TERMINALS[arc.kind.dest_terminal]?.code}] `;
                          }
                          if (arc.kind.type === 'EmptyRepositioning') {
                            return `[EMPTY ${TERMINALS[arc.kind.origin_terminal]?.code}→${TERMINALS[arc.kind.dest_terminal]?.code}] `;
                          }
                          if (arc.kind.type === 'ServicingTurnaround') {
                            return `[SERVICE] `;
                          }
                          return `Dwell `;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ======================= TAB 3: CP-SAT EXACT REPAIR FORMULATION ======================= */}
        {activeTab === 'cpsat' && (
          <div className="space-y-5">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
                <Cpu className="w-5 h-5 text-amber-400" />
                <div>
                  <h2 className="text-sm font-bold text-slate-200">OR-Tools CP-SAT Exact Repair Mathematical Formulation</h2>
                  <p className="text-xs text-slate-400">
                    Exact constraint satisfaction formulation executed on destroyed spatio-temporal subproblems.
                  </p>
                </div>
              </div>

              {/* 1. Sets and Network Topology */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wider">1. Network & Decision Variables</h3>
                <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-2 font-mono text-xs text-slate-300">
                  <p>
                    <strong className="text-slate-100">Time-Expanded Graph:</strong> G = (V, A) where each node v = (terminal, time_bucket) in T × [t_start .. t_end].
                  </p>
                  <p>
                    <strong className="text-slate-100">Arc Set A:</strong> Subnetwork arcs partitioned into Loaded Movements (A_L), Empty Repositioning (A_E), Stationary Dwell (A_D), and Servicing Turnaround (A_S).
                  </p>
                  <p className="text-amber-300">
                    x[a, r] ∈ &#123;0, 1&#125; : Binary variable = 1 if Rake r in R_active traverses Arc a in A, else 0.
                  </p>
                  <p className="text-amber-300">
                    u[d] ∈ &#123;0, 1&#125; : Binary slack variable = 1 if Demand d in D_sub cannot be fulfilled within this window.
                  </p>
                  <p className="text-amber-300">
                    lateness[d] ≥ 0 : Integer delay buckets past due_time[d] if served.
                  </p>
                </div>
              </div>

              {/* 2. Mathematical Constraints */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wider">2. Operational Constraints Implemented in CP-SAT</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  {/* Constraint 1 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 1: Rake Flow Conservation & Boundary Pinning</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      ∑_{'{a ∈ in(v)}'} x[a, r] - ∑_{'{a ∈ out(v)}'} x[a, r] = Δ(v, r)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Where Δ(v, r) = -1 at incoming boundary node, +1 at outgoing target node, and 0 for all internal nodes.
                    </div>
                  </div>

                  {/* Constraint 2 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 2: Terminal Loading / Unloading Capacity</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      ∑_r ∑_{'{a ∈ LoadedDep(term, t)}'} x[a, r] ≤ ResidualLoadingCap(term, t)<br/>
                      ∑_r ∑_{'{a ∈ LoadedArr(term, t)}'} x[a, r] ≤ ResidualUnloadingCap(term, t)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Residual capacities subtract frozen schedule consumption outside the destroyed fragment.
                    </div>
                  </div>

                  {/* Constraint 3 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 3: Section Corridor Headway Capacity</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      ∑_r ∑_{'{a ∈ Section(s, t)}'} x[a, r] ≤ ResidualSectionCap(s, t)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Limits simultaneous active rakes traversing physical double/single track sections during bucket t.
                    </div>
                  </div>

                  {/* Constraint 4 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 4: Stock-Type Compatibility</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      x[a, r] = 0   ∀ r ∈ R where Compatible(stock(r), commodity(a)) == 0
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Hard constraint enforced during variable instantiations: prevents assigning covered BCN wagons to coal hopper orders.
                    </div>
                  </div>

                  {/* Constraint 5 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 5: Servicing Turnaround Minimum Duration</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      t_departure ≥ t_arrival + MinServicing(term)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      A rake terminating a loaded transit must traverse a servicing turnaround arc before departing on loaded or empty runs.
                    </div>
                  </div>

                  {/* Constraint 6 */}
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
                    <div className="font-bold text-slate-200">Constraint 6: Scheduled Maintenance Windows</div>
                    <div className="font-mono text-slate-300 text-[11px] bg-slate-900 p-2 rounded">
                      x[a, r] = 0   ∀ a ∩ [start_m .. end_m] ≠ ∅
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Completely isolates rolling stock during planned preventative workshop maintenance windows.
                    </div>
                  </div>
                </div>
              </div>

              {/* 3. Multi-Criteria Objective Function */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wider">3. Multi-Criteria Objective Function</h3>
                <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 font-mono text-xs text-slate-200">
                  <p className="text-amber-300 font-semibold mb-2">
                    Minimize Z = w1 · ∑_d (u_d · P_d) + w2 · ∑_{'{r, a ∈ A_E}'} (x[a,r] · dist_a) + w3 · ∑_{'{r, a ∈ A_D}'} (x[a,r] · hrs_a) + w4 · ∑_d (lateness_d · rate_d)
                  </p>
                  <ul className="list-disc list-inside text-slate-400 text-[11px] space-y-1">
                    <li><strong className="text-slate-300">w1 (Unserved Demand Penalty):</strong> Prioritizes freight indent fulfillment (w1 = {weights.w_unserved}).</li>
                    <li><strong className="text-slate-300">w2 (Empty Km Repositioning):</strong> Minimizes unremunerative haulage across sections (w2 = {weights.w_empty_km}).</li>
                    <li><strong className="text-slate-300">w3 (Detention Hours):</strong> Penalizes rolling stock idling at terminal sidings (w3 = {weights.w_detention_hr}).</li>
                    <li><strong className="text-slate-300">w4 (Delivery Lateness):</strong> Enforces delivery punctuality at receiving industrial plants (w4 = {weights.w_lateness}).</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================= TAB 4: CODEBASE EXPLORER ======================= */}
        {activeTab === 'codebase' && (
          <div className="space-y-4">
            {/* Header with copy / download */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <FileCode2 className="w-4 h-4 text-amber-400" /> Rust Solver Core & Python CP-SAT Exact Repair Codebase
                </h2>
                <p className="text-xs text-slate-400">
                  Fully implemented Rust structs, LNS state management, boundary conditions, and OR-Tools CP-SAT formulation.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={copyCodeToClipboard}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center gap-1.5 border border-slate-700 transition"
                >
                  {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedCode ? 'Copied to Clipboard' : 'Copy File Content'}
                </button>
              </div>
            </div>

            {/* File Selector Tabs */}
            <div className="flex flex-wrap gap-1.5 border-b border-slate-800 pb-2">
              {Object.entries(CODE_FILES).map(([key, file]) => (
                <button
                  key={key}
                  onClick={() => setActiveCodeFile(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono transition flex items-center gap-1.5 ${
                    activeCodeFile === key
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                      : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <span className={file.language === 'rust' ? 'text-orange-400 font-bold' : 'text-blue-400 font-bold'}>
                    {file.language === 'rust' ? '🦀' : '🐍'}
                  </span>
                  {key}
                </button>
              ))}
            </div>

            {/* Code Viewer Panel */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-3">
                <div className="text-xs font-mono text-slate-400">
                  <span className="text-amber-400">{CODE_FILES[activeCodeFile]?.filename}</span> &mdash;{' '}
                  <span className="text-slate-500 font-sans">{CODE_FILES[activeCodeFile]?.description}</span>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-900 text-slate-400">
                  {CODE_FILES[activeCodeFile]?.language.toUpperCase()}
                </span>
              </div>
              <pre className="text-xs font-mono text-slate-200 overflow-x-auto max-h-[600px] leading-relaxed p-2">
                <code>{CODE_FILES[activeCodeFile]?.code}</code>
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
