import {
  IncumbentSchedule,
  DestroyedFragment,
  DestroyOperatorKind,
  ObjectiveWeights,
  TimeExpandedArc,
  TransportDemand,
  MaintenanceWindow,
  TerminalCapacity,
  SectionCapacity,
  LnsIterationLog,
  BoundaryRakeState,
} from './types/rake_allocation';
import { evaluateSchedule, isStockCompatible, validateFeasibility, TERMINALS } from './simulator';

export interface LnsRunState {
  currentIteration: number;
  maxIterations: number;
  incumbent: IncumbentSchedule;
  best: IncumbentSchedule;
  temperature: number;
  coolingRate: number;
  history: LnsIterationLog[];
  lastFragment: DestroyedFragment | null;
  isRunning: boolean;
}

// ─── CP-SAT Bridge Status ─────────────────────────────────────────────────────

export type CpSatStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'HEURISTIC';

export interface CpSatRepairResult {
  status: CpSatStatus;
  solve_time_ms: number;
  objective_value: number;
  repaired_rake_paths: Record<string, number[]>;
  repaired_demand_fulfillment: Record<string, { rake_id: number; arrival_bucket: number } | null>;
  message?: string;
}

const CPSAT_BRIDGE_URL = 'http://localhost:3001';

/**
 * Check if the CP-SAT bridge server is available.
 */
export async function checkCpSatBridge(): Promise<boolean> {
  try {
    const resp = await fetch(`${CPSAT_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (resp.ok) {
      const data = await resp.json();
      return data.ortools_available === true;
    }
  } catch {
    // Bridge not running
  }
  return false;
}

// ─── Destroy Logic (unchanged) ────────────────────────────────────────────────

export function createDestroyedFragment(
  schedule: IncumbentSchedule,
  arcs: TimeExpandedArc[],
  demands: TransportDemand[],
  horizon: number,
  terminalCount: number,
  operator: DestroyOperatorKind,
  windowDuration: number = 8,
  clusterCenter?: number
): DestroyedFragment {
  const arcMap = new Map<number, TimeExpandedArc>(arcs.map((a) => [a.arc_id, a]));

  let t_start = 0;
  let t_end = windowDuration;
  let affectedTerminals = new Set<number>();
  let destroyMeta = '';

  if (operator === 'RandomTimeWindow') {
    const maxStart = Math.max(0, horizon - windowDuration);
    t_start = Math.floor(Math.random() * (maxStart + 1));
    t_end = Math.min(horizon, t_start + windowDuration);
    for (let t = 0; t < terminalCount; t++) affectedTerminals.add(t);
    destroyMeta = `Region: t=${t_start}h–${t_end}h`;
  } else if (operator === 'GeographicCluster') {
    const center = clusterCenter ?? Math.floor(Math.random() * terminalCount);
    affectedTerminals.add(center);
    if (center > 0) affectedTerminals.add(center - 1);
    if (center < terminalCount - 1) affectedTerminals.add(center + 1);
    const maxStart = Math.max(0, horizon - windowDuration);
    t_start = Math.floor(Math.random() * (maxStart + 1));
    t_end = Math.min(horizon, t_start + windowDuration);
    
    const terms = Array.from(affectedTerminals).map(tid => TERMINALS[tid]?.code || `T${tid}`);
    destroyMeta = `Anchor: ${terms[0]} · Related: ${terms.slice(1).join(', ')} · Region: t=${t_start}h–${t_end}h`;
  } else {
    // High Detention Targeted
    let maxDwell = -1;
    let bestTStart = 0;
    let bestTerminal = 0;
    
    for (let t = 0; t < terminalCount; t++) {
      for (let st = 0; st <= horizon - windowDuration; st++) {
        let dwellInWindow = 0;
        for (const rake of schedule.fleet) {
          const path = schedule.rake_paths[rake.rake_id] || [];
          for (const aid of path) {
            const arc = arcMap.get(aid);
            if (arc && arc.kind.type === 'StationaryDwell' && arc.from_node.terminal_id === t) {
              if (arc.from_node.time_bucket >= st && arc.from_node.time_bucket < st + windowDuration) {
                dwellInWindow += arc.transit_time_buckets || 1;
              }
            }
          }
        }
        if (dwellInWindow > maxDwell) {
          maxDwell = dwellInWindow;
          bestTStart = st;
          bestTerminal = t;
        }
      }
    }
    
    t_start = bestTStart;
    t_end = Math.min(horizon, bestTStart + windowDuration);
    affectedTerminals.add(bestTerminal);
    if (bestTerminal > 0) affectedTerminals.add(bestTerminal - 1);
    if (bestTerminal < terminalCount - 1) affectedTerminals.add(bestTerminal + 1);
    
    const terms = Array.from(affectedTerminals).map(tid => TERMINALS[tid]?.code || `T${tid}`);
    destroyMeta = `Target: highest detention contributors · Detention targeted: ${maxDwell} hours · Anchor: ${terms[0]}`;
  }

  const destroyedArcIds: number[] = [];
  let destroyedAssignments = 0;
  for (const arc of arcs) {
    const inTime = arc.from_node.time_bucket < t_end && arc.to_node.time_bucket > t_start;
    const inSpace =
      affectedTerminals.has(arc.from_node.terminal_id) || affectedTerminals.has(arc.to_node.terminal_id);
    if (inTime && inSpace) {
      destroyedArcIds.push(arc.arc_id);
      if (schedule.arc_flows[arc.arc_id] && schedule.arc_flows[arc.arc_id].length > 0) {
        destroyedAssignments += schedule.arc_flows[arc.arc_id].length;
      }
    }
  }
  
  destroyMeta += ` · Destroyed assignments: ${destroyedAssignments}`;

  // Extract boundary conditions
  const incomingBoundary: BoundaryRakeState[] = [];
  const outgoingBoundary: BoundaryRakeState[] = [];

  for (const rake of schedule.fleet) {
    const path = schedule.rake_paths[rake.rake_id] || [];
    let entered = false;
    let exited = false;

    // Check rake starting boundary
    if (path.length > 0) {
      const firstArc = arcMap.get(path[0]);
      if (firstArc && firstArc.from_node.time_bucket >= t_start && firstArc.from_node.time_bucket <= t_end) {
        incomingBoundary.push({
          rake_id: rake.rake_id,
          terminal_id: firstArc.from_node.terminal_id,
          boundary_time: firstArc.from_node.time_bucket,
        });
        entered = true;
      }
    }

    for (const aid of path) {
      const arc = arcMap.get(aid);
      if (!arc) continue;

      if (!entered && arc.from_node.time_bucket <= t_start && arc.to_node.time_bucket >= t_start) {
        incomingBoundary.push({
          rake_id: rake.rake_id,
          terminal_id: arc.to_node.terminal_id,
          boundary_time: t_start,
        });
        entered = true;
      }

      if (!exited && arc.from_node.time_bucket <= t_end && arc.to_node.time_bucket >= t_end) {
        outgoingBoundary.push({
          rake_id: rake.rake_id,
          terminal_id: arc.to_node.terminal_id,
          boundary_time: arc.to_node.time_bucket,
        });
        exited = true;
      }
    }
  }

  const unassignedDemandIds: number[] = [];
  const frozenDemandIds: number[] = [];
  for (const d of demands) {
    const inside =
      (d.release_time_bucket >= t_start && d.release_time_bucket <= t_end) ||
      (d.due_time_bucket >= t_start && d.due_time_bucket <= t_end) ||
      affectedTerminals.has(d.origin_terminal) ||
      affectedTerminals.has(d.dest_terminal);
    if (inside) {
      unassignedDemandIds.push(d.demand_id);
    } else {
      frozenDemandIds.push(d.demand_id);
    }
  }

  return {
    operator_used: operator,
    affected_terminals: Array.from(affectedTerminals),
    t_start,
    t_end,
    incoming_boundary: incomingBoundary,
    outgoing_boundary: outgoingBoundary,
    destroyed_arc_ids: destroyedArcIds,
    unassigned_demand_ids: unassignedDemandIds,
    frozen_demand_ids: frozenDemandIds,
    destroy_meta: destroyMeta,
  };
}

// ─── Greedy Heuristic Repair (existing, unchanged) ────────────────────────────

export function executeCpSatRepairStep(
  incumbent: IncumbentSchedule,
  fragment: DestroyedFragment,
  arcs: TimeExpandedArc[],
  demands: TransportDemand[],
  maintenance: MaintenanceWindow[],
  terminalCapacities: Record<string, TerminalCapacity>,
  sectionCapacities: Record<number, SectionCapacity>,
  minServicing: Record<number, number>,
  weights: ObjectiveWeights
): {
  repairedSchedule: IncumbentSchedule;
  solveDurationMs: number;
  cpSatStatus: CpSatStatus;
} {
  const startTime = performance.now();
  const arcMap = new Map<number, TimeExpandedArc>(arcs.map((a) => [a.arc_id, a]));
  const destroyedSet = new Set<number>(fragment.destroyed_arc_ids);

  // Deep clone candidate schedule
  const candidate: IncumbentSchedule = {
    fleet: incumbent.fleet.map((r) => ({ ...r })),
    arc_flows: {},
    rake_paths: {},
    demand_fulfillment: { ...incumbent.demand_fulfillment },
    score: { ...incumbent.score },
  };

  // Re-populate un-destroyed arc flows
  for (const [aidStr, rakes] of Object.entries(incumbent.arc_flows)) {
    const aid = Number(aidStr);
    if (!destroyedSet.has(aid)) {
      candidate.arc_flows[aid] = [...rakes];
    }
  }

  for (const rake of incumbent.fleet) {
    const path = incumbent.rake_paths[rake.rake_id] || [];
    const prefix: number[] = [];
    const suffix: number[] = [];
    for (const aid of path) {
      const arc = arcMap.get(aid);
      if (!arc) continue;
      if (arc.to_node.time_bucket <= fragment.t_start) {
        prefix.push(aid);
      } else if (arc.from_node.time_bucket >= fragment.t_end) {
        suffix.push(aid);
      }
    }

    const inBound = fragment.incoming_boundary.find((b) => b.rake_id === rake.rake_id);
    const outBound = fragment.outgoing_boundary.find((b) => b.rake_id === rake.rake_id);

    const subPath: number[] = [];
    let curTerminal = rake.initial_terminal;
    let curTime = 0;

    if (inBound) {
      curTerminal = inBound.terminal_id;
      curTime = inBound.boundary_time;

      while (curTime < fragment.t_end) {
        const outgoingArcs = arcs.filter(
          (a) =>
            a.from_node.terminal_id === curTerminal &&
            a.from_node.time_bucket === curTime &&
            destroyedSet.has(a.arc_id)
        );

        if (outgoingArcs.length === 0) {
          const dwell = arcs.find(
            (a) =>
              a.from_node.terminal_id === curTerminal &&
              a.from_node.time_bucket === curTime &&
              a.to_node.time_bucket === curTime + 1 &&
              a.kind.type === 'StationaryDwell'
          );
          if (dwell) {
            subPath.push(dwell.arc_id);
            curTime += 1;
          } else {
            break;
          }
          continue;
        }

        let chosenArc: TimeExpandedArc | null = null;
        for (const arc of outgoingArcs) {
          if (arc.kind.type === 'LoadedMovement') {
            const did = arc.kind.demand_id;
            if (fragment.unassigned_demand_ids.includes(did) && !candidate.demand_fulfillment[did]) {
              if (isStockCompatible(rake.stock_type, arc.kind.commodity)) {
                chosenArc = arc;
                candidate.demand_fulfillment[did] = {
                  rake_id: rake.rake_id,
                  arrival_bucket: arc.to_node.time_bucket,
                };
                break;
              }
            }
          }
        }

        if (!chosenArc && outBound && curTerminal !== outBound.terminal_id) {
          chosenArc =
            outgoingArcs.find(
              (a) => a.kind.type === 'EmptyRepositioning' && a.kind.dest_terminal === outBound.terminal_id
            ) || null;
        }

        if (!chosenArc) {
          chosenArc = outgoingArcs.find((a) => a.kind.type === 'ServicingTurnaround') || null;
        }

        if (!chosenArc) {
          chosenArc = outgoingArcs.find((a) => a.kind.type === 'StationaryDwell') || outgoingArcs[0];
        }

        subPath.push(chosenArc.arc_id);
        curTerminal = chosenArc.to_node.terminal_id;
        curTime = chosenArc.to_node.time_bucket;
      }
    }

    const newSuffix: number[] = [];
    while (true) {
      const dwell = arcs.find(
        (a) =>
          a.from_node.terminal_id === curTerminal &&
          a.from_node.time_bucket === curTime &&
          a.to_node.time_bucket === curTime + 1 &&
          a.kind.type === 'StationaryDwell'
      );
      if (dwell) {
        newSuffix.push(dwell.arc_id);
        curTime += 1;
      } else {
        break;
      }
    }

    const fullPath = [...prefix, ...subPath, ...newSuffix];
    candidate.rake_paths[rake.rake_id] = fullPath;
  }

  // Re-index all arc flows
  candidate.arc_flows = {};
  for (const [ridStr, path] of Object.entries(candidate.rake_paths)) {
    const rid = Number(ridStr);
    for (const aid of path) {
      if (!candidate.arc_flows[aid]) candidate.arc_flows[aid] = [];
      candidate.arc_flows[aid].push(rid);
    }
  }

  evaluateSchedule(candidate, arcs, demands, weights);
  const solveDurationMs = Math.round(performance.now() - startTime);

  return {
    repairedSchedule: candidate,
    solveDurationMs: Math.max(1, solveDurationMs),
    cpSatStatus: 'HEURISTIC' as CpSatStatus,
  };
}

// ─── CP-SAT Bridge Repair (async, calls actual OR-Tools) ──────────────────────

/**
 * Build the payload for the CP-SAT bridge and invoke the actual OR-Tools solver.
 * Falls back to heuristic repair if the bridge is unavailable.
 */
export async function executeCpSatBridgeRepair(
  incumbent: IncumbentSchedule,
  fragment: DestroyedFragment,
  arcs: TimeExpandedArc[],
  demands: TransportDemand[],
  maintenance: MaintenanceWindow[],
  terminalCapacities: Record<string, TerminalCapacity>,
  sectionCapacities: Record<number, SectionCapacity>,
  minServicing: Record<number, number>,
  weights: ObjectiveWeights
): Promise<{
  repairedSchedule: IncumbentSchedule;
  solveDurationMs: number;
  cpSatStatus: CpSatStatus;
  cpSatMessage?: string;
}> {
  const destroyedSet = new Set<number>(fragment.destroyed_arc_ids);

  // Collect sub-arcs (only the destroyed region)
  const subArcs = arcs
    .filter(a => destroyedSet.has(a.arc_id))
    .map(a => ({
      arc_id: a.arc_id,
      from_node: a.from_node,
      to_node: a.to_node,
      kind: a.kind,
      distance_km: a.distance_km,
      transit_time_buckets: a.transit_time_buckets,
      section_id: a.section_id,
      allowed_stock_types: a.allowed_stock_types,
    }));

  // Active rakes (those with boundary conditions)
  const activeRakeIds = new Set<number>();
  for (const b of fragment.incoming_boundary) activeRakeIds.add(b.rake_id);
  for (const b of fragment.outgoing_boundary) activeRakeIds.add(b.rake_id);
  const fleetSubset = incumbent.fleet.filter(r => activeRakeIds.has(r.rake_id));

  // Active demands
  const activeDemands = demands.filter(d =>
    fragment.unassigned_demand_ids.includes(d.demand_id)
  );

  // Build residual terminal capacities
  const residualTermCaps: Record<string, { max_loading_rakes: number; max_unloading_rakes: number }> = {};
  for (const [key, cap] of Object.entries(terminalCapacities)) {
    residualTermCaps[key] = {
      max_loading_rakes: cap.max_loading_rakes,
      max_unloading_rakes: cap.max_unloading_rakes,
    };
  }

  // Maintenance windows that overlap the fragment
  const relevantMaint = maintenance.filter(mw =>
    !(mw.end_bucket <= fragment.t_start || mw.start_bucket >= fragment.t_end)
  );

  const payload = {
    fragment: {
      t_start: fragment.t_start,
      t_end: fragment.t_end,
      incoming_boundary: fragment.incoming_boundary,
      outgoing_boundary: fragment.outgoing_boundary,
      affected_terminals: fragment.affected_terminals,
    },
    sub_arcs: subArcs,
    fleet_subset: fleetSubset.map(r => ({
      rake_id: r.rake_id,
      stock_type: r.stock_type,
      initial_terminal: r.initial_terminal,
    })),
    active_demands: activeDemands,
    weights: {
      w_unserved: weights.w_unserved,
      w_empty_km: weights.w_empty_km,
      w_detention_hr: weights.w_detention_hr,
      w_lateness: weights.w_lateness,
    },
    maintenance_windows: relevantMaint,
    residual_terminal_capacities: residualTermCaps,
    timeout_seconds: 5.0,
  };

  console.log(`[LNS] Sending CP-SAT repair: ${subArcs.length} arcs, ${fleetSubset.length} rakes, ${activeDemands.length} demands`);

  try {
    const resp = await fetch(`${CPSAT_BRIDGE_URL}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      throw new Error(`Bridge returned ${resp.status}`);
    }

    const result: CpSatRepairResult = await resp.json();
    console.log(`[LNS] CP-SAT result: ${result.status}, ${result.solve_time_ms}ms, obj=${result.objective_value}`);

    if (result.status === 'OPTIMAL' || result.status === 'FEASIBLE') {
      // Splice the CP-SAT solution into the incumbent
      const candidate = spliceCpSatSolution(
        incumbent, fragment, arcs, result, demands, weights
      );

      return {
        repairedSchedule: candidate,
        solveDurationMs: result.solve_time_ms,
        cpSatStatus: result.status,
      };
    } else {
      // CP-SAT failed (infeasible/timeout) — fall back to heuristic
      console.log(`[LNS] CP-SAT returned ${result.status}, falling back to heuristic`);
      const heuristic = executeCpSatRepairStep(
        incumbent, fragment, arcs, demands, maintenance,
        terminalCapacities, sectionCapacities, minServicing, weights
      );
      return {
        ...heuristic,
        cpSatStatus: result.status,
        cpSatMessage: result.message || `CP-SAT returned ${result.status}`,
      };
    }
  } catch (err: unknown) {
    // Bridge unavailable — fall back to heuristic
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[LNS] CP-SAT bridge unavailable (${msg}), using heuristic repair`);
    const heuristic = executeCpSatRepairStep(
      incumbent, fragment, arcs, demands, maintenance,
      terminalCapacities, sectionCapacities, minServicing, weights
    );
    return {
      ...heuristic,
      cpSatStatus: 'HEURISTIC',
      cpSatMessage: `Bridge unavailable: ${msg}`,
    };
  }
}

/**
 * Splice CP-SAT repair solution back into the incumbent schedule.
 */
function spliceCpSatSolution(
  incumbent: IncumbentSchedule,
  fragment: DestroyedFragment,
  arcs: TimeExpandedArc[],
  cpSatResult: CpSatRepairResult,
  demands: TransportDemand[],
  weights: ObjectiveWeights
): IncumbentSchedule {
  const arcMap = new Map<number, TimeExpandedArc>(arcs.map(a => [a.arc_id, a]));
  const destroyedSet = new Set<number>(fragment.destroyed_arc_ids);

  const candidate: IncumbentSchedule = {
    fleet: incumbent.fleet.map(r => ({ ...r })),
    arc_flows: {},
    rake_paths: {},
    demand_fulfillment: { ...incumbent.demand_fulfillment },
    score: { ...incumbent.score },
  };

  for (const rake of incumbent.fleet) {
    const ridStr = String(rake.rake_id);
    const incumbentPath = incumbent.rake_paths[rake.rake_id] || [];

    // Keep prefix (before destroyed region) and suffix (after)
    const prefix: number[] = [];
    const suffix: number[] = [];
    for (const aid of incumbentPath) {
      const arc = arcMap.get(aid);
      if (!arc) continue;
      if (arc.to_node.time_bucket <= fragment.t_start) {
        prefix.push(aid);
      } else if (arc.from_node.time_bucket >= fragment.t_end) {
        suffix.push(aid);
      }
    }

    // Get CP-SAT repaired path for this rake
    const repairedPath = cpSatResult.repaired_rake_paths[ridStr] || [];

    // Build full path with dwell padding if needed
    let curTerminal = rake.initial_terminal;
    let curTime = 0;

    if (prefix.length > 0) {
      const lastPrefixArc = arcMap.get(prefix[prefix.length - 1]);
      if (lastPrefixArc) {
        curTerminal = lastPrefixArc.to_node.terminal_id;
        curTime = lastPrefixArc.to_node.time_bucket;
      }
    }

    // Fill gap between prefix end and repaired path start with dwell
    const gapFill: number[] = [];
    const repairedStart = repairedPath.length > 0 ? arcMap.get(repairedPath[0])?.from_node.time_bucket : fragment.t_end;
    if (repairedStart !== undefined) {
      while (curTime < repairedStart) {
        const dwell = arcs.find(
          a => a.from_node.terminal_id === curTerminal &&
               a.from_node.time_bucket === curTime &&
               a.to_node.time_bucket === curTime + 1 &&
               a.kind.type === 'StationaryDwell'
        );
        if (dwell) {
          gapFill.push(dwell.arc_id);
          curTime += 1;
        } else break;
      }
    }

    // Update curTerminal/curTime after repaired path
    if (repairedPath.length > 0) {
      const lastRepaired = arcMap.get(repairedPath[repairedPath.length - 1]);
      if (lastRepaired) {
        curTerminal = lastRepaired.to_node.terminal_id;
        curTime = lastRepaired.to_node.time_bucket;
      }
    } else if (gapFill.length > 0) {
      const lastGap = arcMap.get(gapFill[gapFill.length - 1]);
      if (lastGap) {
        curTerminal = lastGap.to_node.terminal_id;
        curTime = lastGap.to_node.time_bucket;
      }
    }

    // Fill gap between repaired path end and suffix/horizon with dwell
    const postFill: number[] = [];
    const suffixStart = suffix.length > 0 ? arcMap.get(suffix[0])?.from_node.time_bucket : undefined;
    const targetTime = suffixStart ?? 36; // horizon
    while (curTime < targetTime) {
      const dwell = arcs.find(
        a => a.from_node.terminal_id === curTerminal &&
             a.from_node.time_bucket === curTime &&
             a.to_node.time_bucket === curTime + 1 &&
             a.kind.type === 'StationaryDwell'
      );
      if (dwell) {
        postFill.push(dwell.arc_id);
        curTime += 1;
      } else break;
    }

    candidate.rake_paths[rake.rake_id] = [...prefix, ...gapFill, ...repairedPath, ...postFill, ...suffix];
  }

  // Update demand fulfillment from CP-SAT result
  for (const [didStr, fulfillment] of Object.entries(cpSatResult.repaired_demand_fulfillment)) {
    const did = Number(didStr);
    if (fulfillment) {
      candidate.demand_fulfillment[did] = fulfillment;
    }
  }

  // Re-index arc flows
  candidate.arc_flows = {};
  for (const [ridStr, path] of Object.entries(candidate.rake_paths)) {
    const rid = Number(ridStr);
    for (const aid of path) {
      if (!candidate.arc_flows[aid]) candidate.arc_flows[aid] = [];
      candidate.arc_flows[aid].push(rid);
    }
  }

  evaluateSchedule(candidate, arcs, demands, weights);
  return candidate;
}
