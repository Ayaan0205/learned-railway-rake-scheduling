export type TerminalId = number;
export type TimeBucket = number;

export type WagonStockType = 'BOXN' | 'BOBRN' | 'BCN' | 'BTPN';

export type Commodity = 
  | 'ThermalCoal'
  | 'CokingCoal'
  | 'IronOre'
  | 'BaggedCement'
  | 'FoodGrain'
  | 'PetroleumProduct';

export interface TimeExpandedNode {
  terminal_id: TerminalId;
  time_bucket: TimeBucket;
}

export type ArcKind = 
  | { type: 'LoadedMovement'; demand_id: number; commodity: Commodity; origin_terminal: TerminalId; dest_terminal: TerminalId }
  | { type: 'EmptyRepositioning'; origin_terminal: TerminalId; dest_terminal: TerminalId; empty_distance_km: number }
  | { type: 'StationaryDwell'; terminal_id: TerminalId; detention_cost_per_hour: number }
  | { type: 'ServicingTurnaround'; terminal_id: TerminalId; required_duration_buckets: number }
  | { type: 'ScheduledMaintenance'; terminal_id: TerminalId; work_order_id: number };

export interface TimeExpandedArc {
  arc_id: number;
  from_node: TimeExpandedNode;
  to_node: TimeExpandedNode;
  kind: ArcKind;
  distance_km: number;
  transit_time_buckets: number;
  section_id?: number;
  allowed_stock_types: WagonStockType[];
}

export interface TerminalCapacity {
  terminal_id: TerminalId;
  time_bucket: TimeBucket;
  max_loading_rakes: number;
  max_unloading_rakes: number;
  max_dwell_capacity: number;
}

export interface SectionCapacity {
  section_id: number;
  from_terminal: TerminalId;
  to_terminal: TerminalId;
  max_simultaneous_rakes: number;
}

export interface TransportDemand {
  demand_id: number;
  origin_terminal: TerminalId;
  dest_terminal: TerminalId;
  commodity: Commodity;
  quantity_rakes: number;
  release_time_bucket: TimeBucket;
  due_time_bucket: TimeBucket;
  penalty_unserved_weight: number;
  lateness_penalty_per_bucket: number;
}

export interface MaintenanceWindow {
  maintenance_id: number;
  rake_id: number;
  terminal_id: TerminalId;
  start_bucket: TimeBucket;
  end_bucket: TimeBucket;
}

export interface RakeAsset {
  rake_id: number;
  stock_type: WagonStockType;
  initial_terminal: TerminalId;
  initial_available_bucket: TimeBucket;
  name?: string;
}

export interface ObjectiveWeights {
  w_unserved: number;
  w_empty_km: number;
  w_detention_hr: number;
  w_lateness: number;
}

export interface ObjectiveScore {
  unserved_demands_count: number;
  unserved_penalty: number;
  total_empty_km: number;
  empty_km_cost: number;
  total_detention_hours: number;
  detention_cost: number;
  total_lateness_buckets: number;
  lateness_penalty: number;
  total_weighted_cost: number;
}

export interface BoundaryRakeState {
  rake_id: number;
  terminal_id: TerminalId;
  boundary_time: TimeBucket;
}

export type DestroyOperatorKind = 'RandomTimeWindow' | 'GeographicCluster' | 'HighDetentionTargeted';

export interface DestroyedFragment {
  operator_used: DestroyOperatorKind;
  affected_terminals: number[];
  t_start: TimeBucket;
  t_end: TimeBucket;
  incoming_boundary: BoundaryRakeState[];
  outgoing_boundary: BoundaryRakeState[];
  destroyed_arc_ids: number[];
  unassigned_demand_ids: number[];
  frozen_demand_ids: number[];
  destroy_meta?: string;
}

export interface IncumbentSchedule {
  fleet: RakeAsset[];
  arc_flows: Record<number, number[]>; // arc_id -> rake_ids
  rake_paths: Record<number, number[]>; // rake_id -> arc_ids
  demand_fulfillment: Record<number, { rake_id: number; arrival_bucket: number } | null>;
  score: ObjectiveScore;
}

export interface FeasibilityReport {
  is_feasible: boolean;
  rake_conservation_violations: string[];
  terminal_capacity_violations: string[];
  section_capacity_violations: string[];
  compatibility_violations: string[];
  servicing_turnaround_violations: string[];
  maintenance_window_violations: string[];
}

export interface LnsIterationLog {
  iteration: number;
  operator: DestroyOperatorKind;
  candidate_cost: number;
  incumbent_cost: number;
  best_cost: number;
  accepted: boolean;
  is_new_best: boolean;
  temperature: number;
  score_breakdown: ObjectiveScore;
  solve_duration_ms: number;
  destroy_meta?: string;
}

export interface TerminalMeta {
  id: TerminalId;
  name: string;
  code: string;
  type: 'Mine' | 'Washery' | 'PowerStation' | 'Port' | 'Cement';
  color: string;
}

export interface TimeExpandedGraph {
  horizon: number;
  terminalCount: number;
  nodes: TimeExpandedNode[];
  arcs: TimeExpandedArc[];
  forwardStar: Record<string, number[]>;
  reverseStar: Record<string, number[]>;
  terminalCapacities: Record<string, TerminalCapacity>;
  sectionCapacities: Record<number, SectionCapacity>;
  demands: TransportDemand[];
  maintenance: MaintenanceWindow[];
  minServicing: Record<number, number>;
}

