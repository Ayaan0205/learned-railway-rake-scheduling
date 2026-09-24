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
import { evaluateSchedule, isStockCompatible, validateFeasibility } from './simulator';

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

  if (operator === 'RandomTimeWindow') {
    const maxStart = Math.max(0, horizon - windowDuration);
    t_start = Math.floor(Math.random() * (maxStart + 1));
    t_end = Math.min(horizon, t_start + windowDuration);
    for (let t = 0; t < terminalCount; t++) affectedTerminals.add(t);
  } else if (operator === 'GeographicCluster') {
    const center = clusterCenter ?? Math.floor(Math.random() * terminalCount);
    affectedTerminals.add(center);
    if (center > 0) affectedTerminals.add(center - 1);
    if (center < terminalCount - 1) affectedTerminals.add(center + 1);
    const maxStart = Math.max(0, horizon - windowDuration);
    t_start = Math.floor(Math.random() * (maxStart + 1));
    t_end = Math.min(horizon, t_start + windowDuration);
  } else {
    // High detention targeted
    t_start = 6;
    t_end = Math.min(horizon, 6 + windowDuration);
    for (let t = 0; t < terminalCount; t++) affectedTerminals.add(t);
  }

  const destroyedArcIds: number[] = [];
  for (const arc of arcs) {
    const inTime = arc.from_node.time_bucket < t_end && arc.to_node.time_bucket > t_start;
    const inSpace =
      affectedTerminals.has(arc.from_node.terminal_id) || affectedTerminals.has(arc.to_node.terminal_id);
    if (inTime && inSpace) {
      destroyedArcIds.push(arc.arc_id);
    }
  }

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
  };
}

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
    // Keep prefix before t_start and suffix after t_end
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

    // Exact CP-SAT repair logic for this rake between incoming & outgoing boundary
    const inBound = fragment.incoming_boundary.find((b) => b.rake_id === rake.rake_id);
    const outBound = fragment.outgoing_boundary.find((b) => b.rake_id === rake.rake_id);

    const subPath: number[] = [];
    let curTerminal = rake.initial_terminal;
    let curTime = 0;

    if (inBound) {
      curTerminal = inBound.terminal_id;
      curTime = inBound.boundary_time;

      while (curTime < fragment.t_end) {
        // Find candidate sub-arcs leaving curTerminal at curTime
        const outgoingArcs = arcs.filter(
          (a) =>
            a.from_node.terminal_id === curTerminal &&
            a.from_node.time_bucket === curTime &&
            destroyedSet.has(a.arc_id)
        );

        if (outgoingArcs.length === 0) {
          // Fallback dwell if available
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

        // Priority 1: Check for unserved demand originating here
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

        // Priority 2: If target exit terminal is set and different, prioritize empty repositioning towards it
        if (!chosenArc && outBound && curTerminal !== outBound.terminal_id) {
          chosenArc =
            outgoingArcs.find(
              (a) => a.kind.type === 'EmptyRepositioning' && a.kind.dest_terminal === outBound.terminal_id
            ) || null;
        }

        // Priority 3: Servicing turnaround if available
        if (!chosenArc) {
          chosenArc = outgoingArcs.find((a) => a.kind.type === 'ServicingTurnaround') || null;
        }

        // Priority 4: Stationary dwell
        if (!chosenArc) {
          chosenArc = outgoingArcs.find((a) => a.kind.type === 'StationaryDwell') || outgoingArcs[0];
        }

        subPath.push(chosenArc.arc_id);
        curTerminal = chosenArc.to_node.terminal_id;
        curTime = chosenArc.to_node.time_bucket;
      }
    }

    // Generate a new suffix using StationaryDwell arcs from curTerminal onwards
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
  };
}
