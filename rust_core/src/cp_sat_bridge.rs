//! OR-Tools CP-SAT Exact Repair Module Bridge
//! 
//! Handles translation of Destroyed Fragments and Boundary Conditions into the exact
//! CP-SAT mathematical programming model (Variables, Constraints, and Multi-Criteria Objective).

use crate::destroy::{BoundaryRakeState, DestroyedFragment};
use crate::graph::{
    ArcKind, Commodity, TerminalId, TimeBucket, TimeExpandedArc, TimeExpandedGraph,
    TimeExpandedNode, WagonStockType,
};
use crate::schedule::{IncumbentSchedule, ObjectiveWeights, RakeAsset};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Input payload sent to the OR-Tools CP-SAT solver process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpSatRepairInput {
    pub fragment: DestroyedFragment,
    pub sub_arcs: Vec<TimeExpandedArc>,
    pub fleet_subset: Vec<RakeAsset>,
    /// Residual terminal capacity available after accounting for frozen schedule
    pub residual_terminal_capacities: HashMap<(TerminalId, TimeBucket), (usize, usize)>, // (max_load, max_unload)
    /// Residual section capacity available after accounting for frozen schedule
    pub residual_section_capacities: HashMap<(usize, TimeBucket), usize>,
    pub active_demands: Vec<crate::graph::TransportDemand>,
    pub weights: ObjectiveWeights,
    pub timeout_seconds: f64,
}

/// Output payload received from the OR-Tools CP-SAT solver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpSatRepairOutput {
    pub status: String, // "OPTIMAL", "FEASIBLE", "INFEASIBLE"
    pub solve_time_ms: u64,
    pub objective_value: f64,
    /// Repaired rake paths within the destroyed window: rake_id -> list of arc_ids
    pub repaired_rake_paths: HashMap<usize, Vec<usize>>,
    /// Repaired demand assignments: demand_id -> (rake_id, arrival_bucket)
    pub repaired_demand_fulfillment: HashMap<usize, Option<(usize, TimeBucket)>>,
}

/// Formulation descriptor detailing the exact mathematical variables and constraints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpSatFormulationDoc {
    pub decision_variables: Vec<String>,
    pub constraints: Vec<String>,
    pub objective_expression: String,
    pub boundary_conditions_enforcement: Vec<String>,
}

impl CpSatRepairInput {
    /// Builds the formulation document for audit and inspection.
    pub fn describe_formulation() -> CpSatFormulationDoc {
        CpSatFormulationDoc {
            decision_variables: vec![
                "x_{a, r} ∈ {0, 1} : Binary indicator if Rake r traverses Arc a in the destroyed subnetwork".to_string(),
                "u_d ∈ {0, 1} : Binary indicator if Demand d is unserved (slack penalty variable)".to_string(),
                "lateness_d ≥ 0 : Integer delay buckets past due_time_bucket for served Demand d".to_string(),
                "flow_in_{v, r}, flow_out_{v, r} : Integer auxiliary flow expressions at node v for rake r".to_string(),
            ],
            constraints: vec![
                // 1. Rake Conservation
                "1. Flow Conservation: For all rakes r and subnetwork nodes v = (term, t): ∑_{a ∈ in(v)} x_{a,r} - ∑_{a ∈ out(v)} x_{a,r} = Boundary_Delta(r, v)".to_string(),
                // 2. Terminal Capacity
                "2. Terminal Loading/Unloading Capacity: ∑_{r} ∑_{a ∈ LoadedArrival(term, t)} x_{a,r} ≤ ResidualUnloadCap(term, t) and LoadedDeparture ≤ ResidualLoadCap(term, t)".to_string(),
                // 3. Section Capacity
                "3. Section Capacity: For each corridor section s and time bucket t: ∑_{r} ∑_{a ∈ Traverse(s, t)} x_{a,r} ≤ ResidualSectionCap(s, t)".to_string(),
                // 4. Stock-Type Compatibility
                "4. Stock Compatibility: If arc a carries commodity c and wagon class of r is incompatible (Compat(r, c) == 0), then x_{a,r} = 0".to_string(),
                // 5. Servicing Turnaround Time
                "5. Servicing Minimum Turnaround: After entering destination node (term, t) from loaded arc a, subsequent loaded/empty departure arc a' must satisfy t_{dep} ≥ t + MinServicing(term)".to_string(),
                // 6. Maintenance Outages
                "6. Scheduled Maintenance: If rake r has maintenance window [t_start_m, t_end_m], x_{a,r} = 0 for any movement arc a intersecting [t_start_m, t_end_m]".to_string(),
            ],
            boundary_conditions_enforcement: vec![
                "Pinned Inflow: For each incoming boundary (r, term_in, t_in): ∑_{a ∈ out(term_in, t_in)} x_{a,r} = 1".to_string(),
                "Pinned Outflow: For each outgoing boundary (r, term_out, t_out): ∑_{a ∈ in(term_out, t_out)} x_{a,r} = 1".to_string(),
                "Frozen Exterior: All arcs and flows outside destroyed fragment are immutable; their capacity utilization is subtracted from terminal and section upper bounds.".to_string(),
            ],
            objective_expression: "Minimize Z = w_unserved * ∑_d u_d * Pen_d + w_empty_km * ∑_{a ∈ Empty} EmptyKm_a * (∑_r x_{a,r}) + w_detention * ∑_{a ∈ Dwell} Hours_a * (∑_r x_{a,r}) + w_lateness * ∑_d lateness_d".to_string(),
        }
    }
}

/// Slices the global problem and creates the CP-SAT input payload.
pub fn prepare_repair_payload(
    schedule: &IncumbentSchedule,
    graph: &TimeExpandedGraph,
    fragment: &DestroyedFragment,
    weights: &ObjectiveWeights,
    timeout_seconds: f64,
) -> CpSatRepairInput {
    // Collect subnetwork arcs
    let mut sub_arcs = Vec::new();
    for &arc_id in &fragment.destroyed_arc_ids {
        if let Some(arc) = graph.arcs.get(arc_id) {
            sub_arcs.push(arc.clone());
        }
    }

    // Determine rakes involved in this fragment
    let mut active_rake_ids = HashSet::new();
    for bound in &fragment.incoming_boundary {
        active_rake_ids.insert(bound.rake_id);
    }
    for bound in &fragment.outgoing_boundary {
        active_rake_ids.insert(bound.rake_id);
    }

    let fleet_subset: Vec<RakeAsset> = schedule
        .fleet
        .iter()
        .filter(|r| active_rake_ids.contains(&r.rake_id))
        .cloned()
        .collect();

    // Compute residual terminal capacities after subtracting frozen schedule usage
    let mut residual_terminals = HashMap::new();
    for t in 0..graph.terminal_count {
        for b in fragment.t_start..=fragment.t_end {
            let cap = graph.terminal_capacities.get(&(t, b)).cloned().unwrap_or(crate::graph::TerminalCapacity {
                terminal_id: t,
                time_bucket: b,
                max_loading_rakes: 4,
                max_unloading_rakes: 4,
                max_dwell_capacity: 10,
            });

            // Count frozen schedule consumption
            let mut frozen_loading = 0;
            let mut frozen_unloading = 0;
            for (&arc_id, rakes) in &schedule.arc_flows {
                if fragment.destroyed_arc_ids.contains(&arc_id) {
                    continue;
                }
                let arc = &graph.arcs[arc_id];
                if let ArcKind::LoadedMovement { origin_terminal, dest_terminal, .. } = arc.kind {
                    if origin_terminal == t && arc.from_node.time_bucket == b {
                        frozen_loading += rakes.len();
                    }
                    if dest_terminal == t && arc.to_node.time_bucket == b {
                        frozen_unloading += rakes.len();
                    }
                }
            }

            let rem_load = cap.max_loading_rakes.saturating_sub(frozen_loading);
            let rem_unload = cap.max_unloading_rakes.saturating_sub(frozen_unloading);
            residual_terminals.insert((t, b), (rem_load, rem_unload));
        }
    }

    // Residual section capacities
    let mut residual_sections = HashMap::new();
    for (&sec_id, sec_cap) in &graph.section_capacities {
        for b in fragment.t_start..fragment.t_end {
            let mut frozen_usage = 0;
            for (&arc_id, rakes) in &schedule.arc_flows {
                if fragment.destroyed_arc_ids.contains(&arc_id) {
                    continue;
                }
                let arc = &graph.arcs[arc_id];
                if arc.section_id == Some(sec_id) && arc.from_node.time_bucket <= b && arc.to_node.time_bucket > b {
                    frozen_usage += rakes.len();
                }
            }
            residual_sections.insert((sec_id, b), sec_cap.max_simultaneous_rakes.saturating_sub(frozen_usage));
        }
    }

    let active_demands: Vec<crate::graph::TransportDemand> = graph
        .demands
        .iter()
        .filter(|d| fragment.unassigned_demand_ids.contains(&d.demand_id))
        .cloned()
        .collect();

    CpSatRepairInput {
        fragment: fragment.clone(),
        sub_arcs,
        fleet_subset,
        residual_terminal_capacities: residual_terminals,
        residual_section_capacities: residual_sections,
        active_demands,
        weights: weights.clone(),
        timeout_seconds,
    }
}

/// Slices the repaired output back into the incumbent schedule.
pub fn splice_repair_solution(
    schedule: &mut IncumbentSchedule,
    graph: &TimeExpandedGraph,
    fragment: &DestroyedFragment,
    repair_output: &CpSatRepairOutput,
) {
    // 1. Remove destroyed arcs from global arc_flows
    for &arc_id in &fragment.destroyed_arc_ids {
        schedule.arc_flows.remove(&arc_id);
    }

    // 2. Re-assign repaired rake paths
    for (&rake_id, repaired_subpath) in &repair_output.repaired_rake_paths {
        if let Some(existing_path) = schedule.rake_paths.get_mut(&rake_id) {
            // Keep prefix before t_start and suffix after t_end
            let mut prefix = Vec::new();
            let mut suffix = Vec::new();

            for &arc_id in existing_path.iter() {
                let arc = &graph.arcs[arc_id];
                if arc.to_node.time_bucket <= fragment.t_start {
                    prefix.push(arc_id);
                } else if arc.from_node.time_bucket >= fragment.t_end {
                    suffix.push(arc_id);
                }
            }

            // Splice: prefix + repaired_subpath + suffix
            let mut new_path = prefix;
            new_path.extend_from_slice(repaired_subpath);
            new_path.extend_from_slice(&suffix);

            *existing_path = new_path;
        }
    }

    // 3. Rebuild arc_flows for repaired arcs
    for (&rake_id, path) in &schedule.rake_paths {
        for &arc_id in path {
            schedule.arc_flows.entry(arc_id).or_default().push(rake_id);
        }
    }

    // 4. Update demand fulfillments
    for (&demand_id, &fulfillment) in &repair_output.repaired_demand_fulfillment {
        schedule.demand_fulfillment.insert(demand_id, fulfillment);
    }
}
