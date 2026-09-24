//! Incumbent Schedule & Multi-Criteria Objective Evaluation for PRJ 287

use crate::graph::{
    ArcKind, Commodity, TerminalId, TimeBucket, TimeExpandedArc, TimeExpandedGraph,
    TimeExpandedNode, WagonStockType,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Objective weight parameters for PRJ 287.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectiveWeights {
    /// Weight w1: Unserved demand penalty (high priority, e.g., 5000.0)
    pub w_unserved: f64,
    /// Weight w2: Empty repositioning cost per kilometre (e.g., 2.5)
    pub w_empty_km: f64,
    /// Weight w3: Yard detention / idling penalty per hour (e.g., 15.0)
    pub w_detention_hr: f64,
    /// Weight w4: Lateness penalty per time bucket past deadline (e.g., 200.0)
    pub w_lateness: f64,
}

impl Default for ObjectiveWeights {
    fn default() -> Self {
        Self {
            w_unserved: 5_000.0,
            w_empty_km: 2.5,
            w_detention_hr: 15.0,
            w_lateness: 250.0,
        }
    }
}

/// Breakdown of the objective cost components.
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

/// Metadata and state for an individual physical rake in the fleet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RakeAsset {
    pub rake_id: usize,
    pub stock_type: WagonStockType,
    pub initial_terminal: TerminalId,
    pub initial_available_bucket: TimeBucket,
}

/// The flow assignment of rakes across arcs in the time-expanded network.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RakeFlowAssignment {
    pub rake_id: usize,
    pub arc_path: Vec<usize>, // Arc IDs traversed in chronological order
}

/// Full Incumbent Schedule representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncumbentSchedule {
    pub fleet: Vec<RakeAsset>,
    /// Arc ID -> List of rake IDs traversing that arc
    pub arc_flows: HashMap<usize, Vec<usize>>,
    /// Rake ID -> Path of arc IDs
    pub rake_paths: HashMap<usize, Vec<usize>>,
    /// Demand ID -> Option<ServedBy> (rake_id, arrival_bucket)
    pub demand_fulfillment: HashMap<usize, Option<(usize, TimeBucket)>>,
    /// Cached objective evaluation
    pub score: ObjectiveScore,
}

/// Result of full constraint validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeasibilityReport {
    pub is_feasible: bool,
    pub rake_conservation_violations: Vec<String>,
    pub terminal_capacity_violations: Vec<String>,
    pub section_capacity_violations: Vec<String>,
    pub compatibility_violations: Vec<String>,
    pub servicing_turnaround_violations: Vec<String>,
    pub maintenance_window_violations: Vec<String>,
}

impl IncumbentSchedule {
    pub fn new(fleet: Vec<RakeAsset>) -> Self {
        Self {
            fleet,
            arc_flows: HashMap::new(),
            rake_paths: HashMap::new(),
            demand_fulfillment: HashMap::new(),
            score: ObjectiveScore::default(),
        }
    }

    /// Evaluates the complete objective function according to PRJ 287 weights.
    pub fn evaluate(&mut self, graph: &TimeExpandedGraph, weights: &ObjectiveWeights) -> &ObjectiveScore {
        let mut unserved_count = 0;
        let mut unserved_pen = 0.0;
        let mut empty_km = 0.0;
        let mut detention_hrs = 0.0;
        let mut lateness_buckets = 0;
        let mut lateness_pen = 0.0;

        // 1. Unserved demand & lateness evaluation
        for demand in &graph.demands {
            match self.demand_fulfillment.get(&demand.demand_id).cloned().flatten() {
                Some((_rake_id, arrival_time)) => {
                    if arrival_time > demand.due_time_bucket {
                        let delay = arrival_time - demand.due_time_bucket;
                        lateness_buckets += delay;
                        lateness_pen += (delay as f64) * demand.lateness_penalty_per_bucket;
                    }
                }
                None => {
                    unserved_count += demand.quantity_rakes;
                    unserved_pen += demand.penalty_unserved_weight * (demand.quantity_rakes as f64);
                }
            }
        }

        // 2. Empty kilometers & Detention hours from arc transitions
        for (&arc_id, rake_list) in &self.arc_flows {
            if rake_list.is_empty() {
                continue;
            }
            if let Some(arc) = graph.arcs.get(arc_id) {
                let volume = rake_list.len() as f64;
                match &arc.kind {
                    ArcKind::EmptyRepositioning { empty_distance_km, .. } => {
                        empty_km += empty_distance_km * volume;
                    }
                    ArcKind::StationaryDwell { detention_cost_per_hour, .. } => {
                        let hours = (arc.transit_time_buckets as f64) * volume;
                        detention_hrs += hours;
                    }
                    _ => {}
                }
            }
        }

        let empty_cost = empty_km * weights.w_empty_km;
        let det_cost = detention_hrs * weights.w_detention_hr;
        let unserved_weighted = unserved_pen * (weights.w_unserved / 1000.0);
        let late_weighted = lateness_pen * (weights.w_lateness / 100.0);

        let total = unserved_weighted + empty_cost + det_cost + late_weighted;

        self.score = ObjectiveScore {
            unserved_demands_count: unserved_count,
            unserved_penalty: unserved_weighted,
            total_empty_km: empty_km,
            empty_km_cost: empty_cost,
            total_detention_hours: detention_hrs,
            detention_cost: det_cost,
            total_lateness_buckets: lateness_buckets,
            lateness_penalty: late_weighted,
            total_weighted_cost: total,
        };

        &self.score
    }

    /// Rigorous validation of all 6 operational railway constraints.
    pub fn validate_feasibility(&self, graph: &TimeExpandedGraph) -> FeasibilityReport {
        let mut report = FeasibilityReport {
            is_feasible: true,
            rake_conservation_violations: Vec::new(),
            terminal_capacity_violations: Vec::new(),
            section_capacity_violations: Vec::new(),
            compatibility_violations: Vec::new(),
            servicing_turnaround_violations: Vec::new(),
            maintenance_window_violations: Vec::new(),
        };

        let rake_map: HashMap<usize, &RakeAsset> = self.fleet.iter().map(|r| (r.rake_id, r)).collect();

        // Constraint 1: Rake Conservation at every node (flow in = flow out, except initial and horizon boundary)
        for rake in &self.fleet {
            if let Some(path) = self.rake_paths.get(&rake.rake_id) {
                for window in path.windows(2) {
                    let arc1 = &graph.arcs[window[0]];
                    let arc2 = &graph.arcs[window[1]];
                    if arc1.to_node != arc2.from_node {
                        report.rake_conservation_violations.push(format!(
                            "Rake {} broken continuity: arc {} ends at ({},{}) but arc {} begins at ({},{})",
                            rake.rake_id, arc1.arc_id, arc1.to_node.terminal_id, arc1.to_node.time_bucket,
                            arc2.arc_id, arc2.from_node.terminal_id, arc2.from_node.time_bucket
                        ));
                    }
                }
            }
        }

        // Constraint 2: Terminal Loading & Unloading Capacity per time bucket
        let mut terminal_loadings: HashMap<(TerminalId, TimeBucket), usize> = HashMap::new();
        let mut terminal_unloadings: HashMap<(TerminalId, TimeBucket), usize> = HashMap::new();

        for (&arc_id, rakes) in &self.arc_flows {
            if rakes.is_empty() {
                continue;
            }
            let arc = &graph.arcs[arc_id];
            if let ArcKind::LoadedMovement { origin_terminal, dest_terminal, .. } = &arc.kind {
                *terminal_loadings.entry((*origin_terminal, arc.from_node.time_bucket)).or_insert(0) += rakes.len();
                *terminal_unloadings.entry((*dest_terminal, arc.to_node.time_bucket)).or_insert(0) += rakes.len();
            }
        }

        for (key, load_count) in terminal_loadings {
            if let Some(cap) = graph.terminal_capacities.get(&key) {
                if load_count > cap.max_loading_rakes {
                    report.terminal_capacity_violations.push(format!(
                        "Terminal {} at bucket {} exceeded loading cap: {} > {}",
                        key.0, key.1, load_count, cap.max_loading_rakes
                    ));
                }
            }
        }
        for (key, unload_count) in terminal_unloadings {
            if let Some(cap) = graph.terminal_capacities.get(&key) {
                if unload_count > cap.max_unloading_rakes {
                    report.terminal_capacity_violations.push(format!(
                        "Terminal {} at bucket {} exceeded unloading cap: {} > {}",
                        key.0, key.1, unload_count, cap.max_unloading_rakes
                    ));
                }
            }
        }

        // Constraint 3: Section Capacity on movement arcs
        let mut section_traffic: HashMap<(usize, TimeBucket), usize> = HashMap::new();
        for (&arc_id, rakes) in &self.arc_flows {
            if rakes.is_empty() {
                continue;
            }
            let arc = &graph.arcs[arc_id];
            if let Some(sec_id) = arc.section_id {
                for b in arc.from_node.time_bucket..arc.to_node.time_bucket {
                    *section_traffic.entry((sec_id, b)).or_insert(0) += rakes.len();
                }
            }
        }
        for ((sec_id, b), traffic) in section_traffic {
            if let Some(sec_cap) = graph.section_capacities.get(&sec_id) {
                if traffic > sec_cap.max_simultaneous_rakes {
                    report.section_capacity_violations.push(format!(
                        "Section {} at bucket {} over capacity: {} rakes > max {}",
                        sec_id, b, traffic, sec_cap.max_simultaneous_rakes
                    ));
                }
            }
        }

        // Constraint 4: Stock-Type Compatibility
        for (&arc_id, rakes) in &self.arc_flows {
            let arc = &graph.arcs[arc_id];
            if let ArcKind::LoadedMovement { commodity, .. } = &arc.kind {
                for &r_id in rakes {
                    if let Some(rake) = rake_map.get(&r_id) {
                        if !rake.stock_type.is_compatible_with(*commodity) {
                            report.compatibility_violations.push(format!(
                                "Incompatible stock: Rake {} of type {:?} cannot carry commodity {:?}",
                                r_id, rake.stock_type, commodity
                            ));
                        }
                    }
                }
            }
        }

        // Constraint 5: Minimum servicing time before released rake re-enters availability
        for rake in &self.fleet {
            if let Some(path) = self.rake_paths.get(&rake.rake_id) {
                for window in path.windows(2) {
                    let prev_arc = &graph.arcs[window[0]];
                    let next_arc = &graph.arcs[window[1]];
                    if let ArcKind::LoadedMovement { dest_terminal, .. } = prev_arc.kind {
                        let min_servicing = graph.min_servicing_buckets.get(&dest_terminal).copied().unwrap_or(2);
                        // The next action must either be servicing or wait for min_servicing buckets
                        if next_arc.from_node.time_bucket < prev_arc.to_node.time_bucket + min_servicing {
                            if !matches!(next_arc.kind, ArcKind::ServicingTurnaround { .. }) {
                                report.servicing_turnaround_violations.push(format!(
                                    "Rake {} dispatched from dest {} at t={} without min servicing (required {} buckets)",
                                    rake.rake_id, dest_terminal, next_arc.from_node.time_bucket, min_servicing
                                ));
                            }
                        }
                    }
                }
            }
        }

        // Constraint 6: Scheduled Maintenance Windows (Rakes removed from pool entirely)
        for mw in &graph.maintenance_windows {
            if let Some(path) = self.rake_paths.get(&mw.rake_id) {
                for &arc_id in path {
                    let arc = &graph.arcs[arc_id];
                    let overlaps = !(arc.to_node.time_bucket <= mw.start_bucket || arc.from_node.time_bucket >= mw.end_bucket);
                    if overlaps && !matches!(arc.kind, ArcKind::ScheduledMaintenance { .. }) {
                        report.maintenance_window_violations.push(format!(
                            "Rake {} active during scheduled maintenance window {} [{}..{}] on arc {}",
                            mw.rake_id, mw.maintenance_id, mw.start_bucket, mw.end_bucket, arc.arc_id
                        ));
                    }
                }
            }
        }

        report.is_feasible = report.rake_conservation_violations.is_empty()
            && report.terminal_capacity_violations.is_empty()
            && report.section_capacity_violations.is_empty()
            && report.compatibility_violations.is_empty()
            && report.servicing_turnaround_violations.is_empty()
            && report.maintenance_window_violations.is_empty();

        report
    }
}
