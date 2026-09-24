import {
  TimeExpandedGraph,
  TimeExpandedNode,
  TimeExpandedArc,
  ArcKind,
  WagonStockType,
  Commodity,
  TerminalCapacity,
  SectionCapacity,
  TransportDemand,
  MaintenanceWindow,
  RakeAsset,
  ObjectiveWeights,
  ObjectiveScore,
  IncumbentSchedule,
  FeasibilityReport,
  DestroyedFragment,
  LnsIterationLog,
  TerminalMeta,
  DestroyOperatorKind,
} from './types/rake_allocation';

export const TERMINALS: TerminalMeta[] = [
  { id: 0, name: 'Korba Mines', code: 'KRBA', type: 'Mine', color: '#f59e0b' },
  { id: 1, name: 'Bilaspur Washery', code: 'BSP', type: 'Washery', color: '#10b981' },
  { id: 2, name: 'Sipat Super Thermal', code: 'SSTP', type: 'PowerStation', color: '#ef4444' },
  { id: 3, name: 'Visakhapatnam Port', code: 'VSKP', type: 'Port', color: '#3b82f6' },
  { id: 4, name: 'Raipur Cement Works', code: 'RPRC', type: 'Cement', color: '#8b5cf6' },
];

export function isStockCompatible(stock: WagonStockType, commodity: Commodity): boolean {
  if (stock === 'BOXN') {
    return commodity === 'ThermalCoal' || commodity === 'CokingCoal' || commodity === 'IronOre';
  }
  if (stock === 'BOBRN') {
    return commodity === 'ThermalCoal' || commodity === 'CokingCoal';
  }
  if (stock === 'BCN') {
    return commodity === 'BaggedCement' || commodity === 'FoodGrain';
  }
  if (stock === 'BTPN') {
    return commodity === 'PetroleumProduct';
  }
  return false;
}

export function buildBenchmarkGraph(horizon: number = 36): {
  graph: {
    horizon: number;
    terminals: TerminalMeta[];
    nodes: TimeExpandedNode[];
    arcs: TimeExpandedArc[];
    demands: TransportDemand[];
    maintenance: MaintenanceWindow[];
    terminalCapacities: Record<string, TerminalCapacity>;
    sectionCapacities: Record<number, SectionCapacity>;
    minServicing: Record<number, number>;
  };
  fleet: RakeAsset[];
  initialSchedule: IncumbentSchedule;
} {
  const nodes: TimeExpandedNode[] = [];
  for (let t = 0; t < TERMINALS.length; t++) {
    for (let b = 0; b <= horizon; b++) {
      nodes.push({ terminal_id: t, time_bucket: b });
    }
  }

  const minServicing: Record<number, number> = {
    0: 2,
    1: 2,
    2: 3,
    3: 3,
    4: 2,
  };

  const terminalCapacities: Record<string, TerminalCapacity> = {};
  for (let t = 0; t < TERMINALS.length; t++) {
    for (let b = 0; b <= horizon; b++) {
      terminalCapacities[`${t}_${b}`] = {
        terminal_id: t,
        time_bucket: b,
        max_loading_rakes: t === 0 || t === 1 ? 3 : 1,
        max_unloading_rakes: t === 2 || t === 3 ? 3 : 1,
        max_dwell_capacity: 8,
      };
    }
  }

  const sectionCapacities: Record<number, SectionCapacity> = {
    101: { section_id: 101, from_terminal: 0, to_terminal: 2, max_simultaneous_rakes: 4 },
    102: { section_id: 102, from_terminal: 0, to_terminal: 3, max_simultaneous_rakes: 3 },
    103: { section_id: 103, from_terminal: 1, to_terminal: 4, max_simultaneous_rakes: 2 },
  };

  const arcs: TimeExpandedArc[] = [];
  let arcId = 0;

  // 1. Stationary Dwell Arcs
  for (let t = 0; t < TERMINALS.length; t++) {
    for (let b = 0; b < horizon; b++) {
      arcs.push({
        arc_id: arcId++,
        from_node: { terminal_id: t, time_bucket: b },
        to_node: { terminal_id: t, time_bucket: b + 1 },
        kind: { type: 'StationaryDwell', terminal_id: t, detention_cost_per_hour: 15.0 },
        distance_km: 0,
        transit_time_buckets: 1,
        allowed_stock_types: ['BOXN', 'BOBRN', 'BCN', 'BTPN'],
      });
    }
  }

  // 2. Servicing Turnaround Arcs at unloading plants (Terminals 2, 3, 4)
  for (const t of [2, 3, 4]) {
    const dur = minServicing[t] || 2;
    for (let b = 0; b <= horizon - dur; b++) {
      arcs.push({
        arc_id: arcId++,
        from_node: { terminal_id: t, time_bucket: b },
        to_node: { terminal_id: t, time_bucket: b + dur },
        kind: { type: 'ServicingTurnaround', terminal_id: t, required_duration_buckets: dur },
        distance_km: 0,
        transit_time_buckets: dur,
        allowed_stock_types: ['BOXN', 'BOBRN', 'BCN', 'BTPN'],
      });
    }
  }

  // 3. Movement arcs between Mines and Sipat Power Station (Corridor 101)
  for (let b = 0; b <= horizon - 4; b++) {
    // Loaded movement (Mines -> Sipat, 4 buckets, 240km)
    arcs.push({
      arc_id: arcId++,
      from_node: { terminal_id: 0, time_bucket: b },
      to_node: { terminal_id: 2, time_bucket: b + 4 },
      kind: {
        type: 'LoadedMovement',
        demand_id: 101,
        commodity: 'ThermalCoal',
        origin_terminal: 0,
        dest_terminal: 2,
      },
      distance_km: 240,
      transit_time_buckets: 4,
      section_id: 101,
      allowed_stock_types: ['BOXN', 'BOBRN'],
    });

    // Empty repositioning (Sipat -> Mines, 3 buckets, 240km)
    arcs.push({
      arc_id: arcId++,
      from_node: { terminal_id: 2, time_bucket: b },
      to_node: { terminal_id: 0, time_bucket: b + 3 },
      kind: {
        type: 'EmptyRepositioning',
        origin_terminal: 2,
        dest_terminal: 0,
        empty_distance_km: 240,
      },
      distance_km: 240,
      transit_time_buckets: 3,
      section_id: 101,
      allowed_stock_types: ['BOXN', 'BOBRN'],
    });
  }

  // 4. Movement arcs between Mines and Vizag Port (Corridor 102)
  for (let b = 0; b <= horizon - 6; b++) {
    arcs.push({
      arc_id: arcId++,
      from_node: { terminal_id: 0, time_bucket: b },
      to_node: { terminal_id: 3, time_bucket: b + 6 },
      kind: {
        type: 'LoadedMovement',
        demand_id: 102,
        commodity: 'IronOre',
        origin_terminal: 0,
        dest_terminal: 3,
      },
      distance_km: 480,
      transit_time_buckets: 6,
      section_id: 102,
      allowed_stock_types: ['BOXN'],
    });

    arcs.push({
      arc_id: arcId++,
      from_node: { terminal_id: 3, time_bucket: b },
      to_node: { terminal_id: 0, time_bucket: b + 5 },
      kind: {
        type: 'EmptyRepositioning',
        origin_terminal: 3,
        dest_terminal: 0,
        empty_distance_km: 480,
      },
      distance_km: 480,
      transit_time_buckets: 5,
      section_id: 102,
      allowed_stock_types: ['BOXN'],
    });
  }

  // Demands
  const demands: TransportDemand[] = [
    {
      demand_id: 101,
      origin_terminal: 0,
      dest_terminal: 2,
      commodity: 'ThermalCoal',
      quantity_rakes: 4,
      release_time_bucket: 2,
      due_time_bucket: 14,
      penalty_unserved_weight: 10000,
      lateness_penalty_per_bucket: 300,
    },
    {
      demand_id: 102,
      origin_terminal: 0,
      dest_terminal: 3,
      commodity: 'IronOre',
      quantity_rakes: 3,
      release_time_bucket: 4,
      due_time_bucket: 22,
      penalty_unserved_weight: 8500,
      lateness_penalty_per_bucket: 250,
    },
    {
      demand_id: 103,
      origin_terminal: 1,
      dest_terminal: 4,
      commodity: 'BaggedCement',
      quantity_rakes: 2,
      release_time_bucket: 6,
      due_time_bucket: 18,
      penalty_unserved_weight: 6000,
      lateness_penalty_per_bucket: 200,
    },
  ];

  // Maintenance Windows (Constraint 6)
  const maintenance: MaintenanceWindow[] = [
    {
      maintenance_id: 1,
      rake_id: 4, // Rake #4 scheduled maintenance window
      terminal_id: 1,
      start_bucket: 10,
      end_bucket: 18,
    },
  ];

  // Fleet Assets (10 rakes)
  const fleet: RakeAsset[] = [
    { rake_id: 0, stock_type: 'BOBRN', initial_terminal: 0, initial_available_bucket: 0, name: 'BOBRN-01' },
    { rake_id: 1, stock_type: 'BOBRN', initial_terminal: 0, initial_available_bucket: 0, name: 'BOBRN-02' },
    { rake_id: 2, stock_type: 'BOBRN', initial_terminal: 0, initial_available_bucket: 0, name: 'BOBRN-03' },
    { rake_id: 3, stock_type: 'BOXN', initial_terminal: 0, initial_available_bucket: 0, name: 'BOXN-01' },
    { rake_id: 4, stock_type: 'BOXN', initial_terminal: 1, initial_available_bucket: 0, name: 'BOXN-02 (Maint)' },
    { rake_id: 5, stock_type: 'BOXN', initial_terminal: 2, initial_available_bucket: 0, name: 'BOXN-03' },
    { rake_id: 6, stock_type: 'BOXN', initial_terminal: 3, initial_available_bucket: 0, name: 'BOXN-04' },
    { rake_id: 7, stock_type: 'BCN', initial_terminal: 1, initial_available_bucket: 0, name: 'BCN-01' },
    { rake_id: 8, stock_type: 'BCN', initial_terminal: 4, initial_available_bucket: 0, name: 'BCN-02' },
    { rake_id: 9, stock_type: 'BOBRN', initial_terminal: 2, initial_available_bucket: 0, name: 'BOBRN-04' },
  ];

  // Construct initial naive schedule: pure dwell
  const initialSchedule: IncumbentSchedule = {
    fleet,
    arc_flows: {},
    rake_paths: {},
    demand_fulfillment: { 101: null, 102: null, 103: null },
    score: {
      unserved_demands_count: 9,
      unserved_penalty: 9 * 8000,
      total_empty_km: 0,
      empty_km_cost: 0,
      total_detention_hours: 10 * horizon,
      detention_cost: 10 * horizon * 15,
      total_lateness_buckets: 0,
      lateness_penalty: 0,
      total_weighted_cost: 0,
    },
  };

  // Assign initial dwell paths
  for (const rake of fleet) {
    const path: number[] = [];
    for (let b = 0; b < horizon; b++) {
      const dwellArc = arcs.find(
        (a) =>
          a.from_node.terminal_id === rake.initial_terminal &&
          a.from_node.time_bucket === b &&
          a.to_node.time_bucket === b + 1 &&
          a.kind.type === 'StationaryDwell'
      );
      if (dwellArc) {
        path.push(dwellArc.arc_id);
        if (!initialSchedule.arc_flows[dwellArc.arc_id]) {
          initialSchedule.arc_flows[dwellArc.arc_id] = [];
        }
        initialSchedule.arc_flows[dwellArc.arc_id].push(rake.rake_id);
      }
    }
    initialSchedule.rake_paths[rake.rake_id] = path;
  }

  evaluateSchedule(initialSchedule, arcs, demands, {
    w_unserved: 5000,
    w_empty_km: 2.5,
    w_detention_hr: 15.0,
    w_lateness: 250.0,
  });

  return {
    graph: {
      horizon,
      terminals: TERMINALS,
      nodes,
      arcs,
      demands,
      maintenance,
      terminalCapacities,
      sectionCapacities,
      minServicing,
    },
    fleet,
    initialSchedule,
  };
}

export function evaluateSchedule(
  schedule: IncumbentSchedule,
  arcs: TimeExpandedArc[],
  demands: TransportDemand[],
  weights: ObjectiveWeights
): ObjectiveScore {
  let unservedCount = 0;
  let unservedPen = 0;
  let latenessBuckets = 0;
  let latenessPen = 0;

  for (const d of demands) {
    const served = schedule.demand_fulfillment[d.demand_id];
    if (served) {
      if (served.arrival_bucket > d.due_time_bucket) {
        const delay = served.arrival_bucket - d.due_time_bucket;
        latenessBuckets += delay;
        latenessPen += delay * d.lateness_penalty_per_bucket;
      }
    } else {
      unservedCount += d.quantity_rakes;
      unservedPen += d.penalty_unserved_weight * d.quantity_rakes;
    }
  }

  let emptyKm = 0;
  let detentionHours = 0;
  const arcMap = new Map<number, TimeExpandedArc>(arcs.map((a) => [a.arc_id, a]));

  for (const [arcIdStr, rakes] of Object.entries(schedule.arc_flows)) {
    if (!rakes || rakes.length === 0) continue;
    const arc = arcMap.get(Number(arcIdStr));
    if (!arc) continue;
    const vol = rakes.length;
    if (arc.kind.type === 'EmptyRepositioning') {
      emptyKm += arc.kind.empty_distance_km * vol;
    } else if (arc.kind.type === 'StationaryDwell') {
      detentionHours += arc.transit_time_buckets * vol;
    }
  }

  const emptyCost = emptyKm * weights.w_empty_km;
  const detCost = detentionHours * weights.w_detention_hr;
  const unservedWeighted = unservedPen * (weights.w_unserved / 1000.0);
  const lateWeighted = latenessPen * (weights.w_lateness / 100.0);

  const total = unservedWeighted + emptyCost + detCost + lateWeighted;

  schedule.score = {
    unserved_demands_count: unservedCount,
    unserved_penalty: unservedWeighted,
    total_empty_km: emptyKm,
    empty_km_cost: emptyCost,
    total_detention_hours: detentionHours,
    detention_cost: detCost,
    total_lateness_buckets: latenessBuckets,
    lateness_penalty: lateWeighted,
    total_weighted_cost: total,
  };

  return schedule.score;
}

export function validateFeasibility(
  schedule: IncumbentSchedule,
  arcs: TimeExpandedArc[],
  maintenanceWindows: MaintenanceWindow[],
  terminalCapacities: Record<string, TerminalCapacity>,
  sectionCapacities: Record<number, SectionCapacity>,
  minServicing: Record<number, number>
): FeasibilityReport {
  const arcMap = new Map<number, TimeExpandedArc>(arcs.map((a) => [a.arc_id, a]));
  const rakeMap = new Map<number, RakeAsset>(schedule.fleet.map((r) => [r.rake_id, r]));

  const rakeCons: string[] = [];
  const termCaps: string[] = [];
  const secCaps: string[] = [];
  const compatViolations: string[] = [];
  const servicingViolations: string[] = [];
  const maintViolations: string[] = [];

  // Constraint 1: Conservation / continuity
  for (const rake of schedule.fleet) {
    const path = schedule.rake_paths[rake.rake_id];
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i++) {
      const a1 = arcMap.get(path[i]);
      const a2 = arcMap.get(path[i + 1]);
      if (a1 && a2) {
        if (
          a1.to_node.terminal_id !== a2.from_node.terminal_id ||
          a1.to_node.time_bucket !== a2.from_node.time_bucket
        ) {
          rakeCons.push(
            `Rake #${rake.rake_id} broken arc continuity: (${a1.to_node.terminal_id}, t=${a1.to_node.time_bucket}) -> (${a2.from_node.terminal_id}, t=${a2.from_node.time_bucket})`
          );
        }
      }
    }
  }

  // Constraint 2: Terminal Loading / Unloading
  const termLoads: Record<string, number> = {};
  const termUnloads: Record<string, number> = {};
  for (const [arcIdStr, rakes] of Object.entries(schedule.arc_flows)) {
    if (!rakes || rakes.length === 0) continue;
    const arc = arcMap.get(Number(arcIdStr));
    if (!arc || arc.kind.type !== 'LoadedMovement') continue;
    const originKey = `${arc.kind.origin_terminal}_${arc.from_node.time_bucket}`;
    const destKey = `${arc.kind.dest_terminal}_${arc.to_node.time_bucket}`;
    termLoads[originKey] = (termLoads[originKey] || 0) + rakes.length;
    termUnloads[destKey] = (termUnloads[destKey] || 0) + rakes.length;
  }

  for (const [key, count] of Object.entries(termLoads)) {
    const cap = terminalCapacities[key];
    if (cap && count > cap.max_loading_rakes) {
      termCaps.push(`Terminal ${cap.terminal_id} bucket ${cap.time_bucket} loading cap exceeded: ${count} > ${cap.max_loading_rakes}`);
    }
  }
  for (const [key, count] of Object.entries(termUnloads)) {
    const cap = terminalCapacities[key];
    if (cap && count > cap.max_unloading_rakes) {
      termCaps.push(`Terminal ${cap.terminal_id} bucket ${cap.time_bucket} unloading cap exceeded: ${count} > ${cap.max_unloading_rakes}`);
    }
  }

  // Constraint 3: Section capacity
  const secTraffic: Record<string, number> = {};
  for (const [arcIdStr, rakes] of Object.entries(schedule.arc_flows)) {
    if (!rakes || rakes.length === 0) continue;
    const arc = arcMap.get(Number(arcIdStr));
    if (!arc || !arc.section_id) continue;
    for (let b = arc.from_node.time_bucket; b < arc.to_node.time_bucket; b++) {
      const key = `${arc.section_id}_${b}`;
      secTraffic[key] = (secTraffic[key] || 0) + rakes.length;
    }
  }
  for (const [key, traffic] of Object.entries(secTraffic)) {
    const [secIdStr, bucketStr] = key.split('_');
    const secCap = sectionCapacities[Number(secIdStr)];
    if (secCap && traffic > secCap.max_simultaneous_rakes) {
      secCaps.push(`Section ${secIdStr} at bucket ${bucketStr} exceeded track capacity: ${traffic} > ${secCap.max_simultaneous_rakes}`);
    }
  }

  // Constraint 4: Stock type compatibility
  for (const [arcIdStr, rakes] of Object.entries(schedule.arc_flows)) {
    const arc = arcMap.get(Number(arcIdStr));
    if (!arc || arc.kind.type !== 'LoadedMovement') continue;
    for (const rid of rakes) {
      const rake = rakeMap.get(rid);
      if (rake && !isStockCompatible(rake.stock_type, arc.kind.commodity)) {
        compatViolations.push(`Rake #${rid} (${rake.stock_type}) incompatible with ${arc.kind.commodity} on arc #${arc.arc_id}`);
      }
    }
  }

  // Constraint 5: Servicing Turnaround
  for (const rake of schedule.fleet) {
    const path = schedule.rake_paths[rake.rake_id];
    if (!path) continue;
    for (let i = 0; i < path.length - 1; i++) {
      const a1 = arcMap.get(path[i]);
      const a2 = arcMap.get(path[i + 1]);
      if (a1 && a2 && a1.kind.type === 'LoadedMovement') {
        const dest = a1.kind.dest_terminal;
        const required = minServicing[dest] || 2;
        if (a2.from_node.time_bucket < a1.to_node.time_bucket + required && a2.kind.type !== 'ServicingTurnaround') {
          servicingViolations.push(`Rake #${rake.rake_id} departing terminal ${dest} before ${required} buckets servicing turnaround`);
        }
      }
    }
  }

  // Constraint 6: Maintenance Windows
  for (const mw of maintenanceWindows) {
    const path = schedule.rake_paths[mw.rake_id];
    if (!path) continue;
    for (const aid of path) {
      const arc = arcMap.get(aid);
      if (!arc) continue;
      const overlaps = !(arc.to_node.time_bucket <= mw.start_bucket || arc.from_node.time_bucket >= mw.end_bucket);
      if (overlaps) {
        const isValidDwell = arc.kind.type === 'StationaryDwell' && arc.from_node.terminal_id === mw.terminal_id;
        if (arc.kind.type !== 'ScheduledMaintenance' && !isValidDwell) {
          maintViolations.push(`Rake #${mw.rake_id} active during maintenance window [${mw.start_bucket}..${mw.end_bucket}]`);
        }
      }
    }
  }

  const is_feasible =
    rakeCons.length === 0 &&
    termCaps.length === 0 &&
    secCaps.length === 0 &&
    compatViolations.length === 0 &&
    servicingViolations.length === 0 &&
    maintViolations.length === 0;

  return {
    is_feasible,
    rake_conservation_violations: rakeCons,
    terminal_capacity_violations: termCaps,
    section_capacity_violations: secCaps,
    compatibility_violations: compatViolations,
    servicing_turnaround_violations: servicingViolations,
    maintenance_window_violations: maintViolations,
  };
}
