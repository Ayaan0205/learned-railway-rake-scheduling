//! Handcrafted Destroy Operators & Boundary Condition Extraction for LNS

use crate::graph::{TerminalId, TimeBucket, TimeExpandedArc, TimeExpandedGraph, TimeExpandedNode};
use crate::schedule::{IncumbentSchedule, RakeAsset};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Destroy Operator selection strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DestroyOperatorKind {
    /// Destroy all rake decisions within a randomized time window [t_start, t_start + duration]
    RandomTimeWindow,
    /// Destroy all rake decisions around a geographic terminal cluster
    GeographicCluster,
    /// Targeted destroy: select rakes with high detention or late delivery
    HighDetentionTargeted,
}

/// Boundary state of an individual rake entering or exiting the destroyed zone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryRakeState {
    pub rake_id: usize,
    pub terminal_id: TerminalId,
    pub boundary_time: TimeBucket,
}

/// Specification of the destroyed fragment that must be re-optimized by CP-SAT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestroyedFragment {
    pub operator_used: DestroyOperatorKind,
    pub affected_terminals: HashSet<TerminalId>,
    pub t_start: TimeBucket,
    pub t_end: TimeBucket,
    /// Rakes that enter the destroyed window and their initial locations/times at the boundary
    pub incoming_boundary: Vec<BoundaryRakeState>,
    /// Target outgoing positions/times expected by the fixed downstream schedule
    pub outgoing_boundary: Vec<BoundaryRakeState>,
    /// Arc IDs in the time-expanded graph that are destroyed and unassigned
    pub destroyed_arc_ids: HashSet<usize>,
    /// Demands that fall within or overlap the destroyed window
    pub unassigned_demand_ids: HashSet<usize>,
    /// Demands whose assignments are kept frozen outside this fragment
    pub frozen_demand_ids: HashSet<usize>,
}

/// Handcrafted destroy operator interface.
pub trait DestroyOperator {
    fn destroy(
        &self,
        schedule: &IncumbentSchedule,
        graph: &TimeExpandedGraph,
        rng: &mut impl Rng,
    ) -> DestroyedFragment;
}

/// 1. Random Time-Window Destroy Operator
pub struct RandomTimeWindowDestroy {
    pub window_duration: u32,
}

impl DestroyOperator for RandomTimeWindowDestroy {
    fn destroy(
        &self,
        schedule: &IncumbentSchedule,
        graph: &TimeExpandedGraph,
        rng: &mut impl Rng,
    ) -> DestroyedFragment {
        let max_start = if graph.horizon_buckets > self.window_duration {
            graph.horizon_buckets - self.window_duration
        } else {
            0
        };
        let t_start = rng.gen_range(0..=max_start);
        let t_end = (t_start + self.window_duration).min(graph.horizon_buckets);

        let all_terminals: HashSet<TerminalId> = (0..graph.terminal_count).collect();
        extract_boundary_and_fragment(
            schedule,
            graph,
            DestroyOperatorKind::RandomTimeWindow,
            all_terminals,
            t_start,
            t_end,
        )
    }
}

/// 2. Geographic Cluster Destroy Operator
pub struct GeographicClusterDestroy {
    pub cluster_size: usize,
    pub window_duration: u32,
}

impl DestroyOperator for GeographicClusterDestroy {
    fn destroy(
        &self,
        schedule: &IncumbentSchedule,
        graph: &TimeExpandedGraph,
        rng: &mut impl Rng,
    ) -> DestroyedFragment {
        let center_terminal = rng.gen_range(0..graph.terminal_count);
        let mut affected = HashSet::new();
        affected.insert(center_terminal);
        // Include adjacent terminals
        for offset in 1..=self.cluster_size {
            if center_terminal + offset < graph.terminal_count {
                affected.insert(center_terminal + offset);
            }
            if center_terminal >= offset {
                affected.insert(center_terminal - offset);
            }
        }

        let max_start = if graph.horizon_buckets > self.window_duration {
            graph.horizon_buckets - self.window_duration
        } else {
            0
        };
        let t_start = rng.gen_range(0..=max_start);
        let t_end = (t_start + self.window_duration).min(graph.horizon_buckets);

        extract_boundary_and_fragment(
            schedule,
            graph,
            DestroyOperatorKind::GeographicCluster,
            affected,
            t_start,
            t_end,
        )
    }
}

/// Internal helper: Extracts boundary conditions and identifies destroyed arcs & demands.
fn extract_boundary_and_fragment(
    schedule: &IncumbentSchedule,
    graph: &TimeExpandedGraph,
    operator: DestroyOperatorKind,
    affected_terminals: HashSet<TerminalId>,
    t_start: TimeBucket,
    t_end: TimeBucket,
) -> DestroyedFragment {
    let mut destroyed_arcs = HashSet::new();
    let mut incoming_boundary = Vec::new();
    let mut outgoing_boundary = Vec::new();

    // Identify all arcs inside the spatio-temporal box [affected_terminals, t_start..t_end]
    for arc in &graph.arcs {
        let in_time = arc.from_node.time_bucket < t_end && arc.to_node.time_bucket > t_start;
        let in_space = affected_terminals.contains(&arc.from_node.terminal_id)
            || affected_terminals.contains(&arc.to_node.terminal_id);

        if in_time && in_space {
            destroyed_arcs.insert(arc.arc_id);
        }
    }

    // For every rake in the fleet, identify boundary conditions
    for rake in &schedule.fleet {
        let path = match schedule.rake_paths.get(&rake.rake_id) {
            Some(p) => p,
            None => continue,
        };

        // Find incoming boundary: where is the rake right at or just before t_start?
        let mut entered = false;
        let mut exited = false;

        // If rake's first arc starts >= t_start, boundary is its initial starting state
        if let Some(&first_arc_id) = path.first() {
            let first_arc = &graph.arcs[first_arc_id];
            if first_arc.from_node.time_bucket >= t_start && first_arc.from_node.time_bucket <= t_end {
                incoming_boundary.push(BoundaryRakeState {
                    rake_id: rake.rake_id,
                    terminal_id: first_arc.from_node.terminal_id,
                    boundary_time: first_arc.from_node.time_bucket,
                });
                entered = true;
            }
        }

        for &arc_id in path {
            let arc = &graph.arcs[arc_id];

            // Crossing into the destroyed zone from an external arc
            if !entered && arc.from_node.time_bucket <= t_start && arc.to_node.time_bucket >= t_start {
                incoming_boundary.push(BoundaryRakeState {
                    rake_id: rake.rake_id,
                    terminal_id: arc.to_node.terminal_id,
                    boundary_time: t_start,
                });
                entered = true;
            }

            // Crossing out of the destroyed zone into the fixed downstream schedule
            if !exited && arc.from_node.time_bucket <= t_end && arc.to_node.time_bucket >= t_end {
                outgoing_boundary.push(BoundaryRakeState {
                    rake_id: rake.rake_id,
                    terminal_id: arc.to_node.terminal_id,
                    boundary_time: arc.to_node.time_bucket,
                });
                exited = true;
            }
        }
    }

    // Identify affected demands
    let mut unassigned_demands = HashSet::new();
    let mut frozen_demands = HashSet::new();

    for demand in &graph.demands {
        let inside = (demand.release_time_bucket >= t_start && demand.release_time_bucket <= t_end)
            || (demand.due_time_bucket >= t_start && demand.due_time_bucket <= t_end)
            || affected_terminals.contains(&demand.origin_terminal)
            || affected_terminals.contains(&demand.dest_terminal);

        if inside {
            unassigned_demands.insert(demand.demand_id);
        } else {
            frozen_demands.insert(demand.demand_id);
        }
    }

    DestroyedFragment {
        operator_used: operator,
        affected_terminals,
        t_start,
        t_end,
        incoming_boundary,
        outgoing_boundary,
        destroyed_arc_ids: destroyed_arcs,
        unassigned_demand_ids: unassigned_demands,
        frozen_demand_ids: frozen_demands,
    }
}
