//! Time-Expanded Network Graph for Railway Rake Allocation (PRJ 287)
//! 
//! Defines the discretized spatio-temporal topology where:
//! - Nodes represent (Terminal, TimeBucket)
//! - Arcs represent Rake Transitions: Loaded Movement, Empty Repositioning, or Stationary Dwell.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Unique identifier for physical rail terminals / yards.
pub type TerminalId = usize;

/// Discretized temporal planning horizon index (e.g., 1-hour or 2-hour increments).
pub type TimeBucket = u32;

/// Wagon / Rake stock classification (e.g., Open Gondola BOXN, Rapid Discharge Hopper BOBRN, Covered BCN).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WagonStockType {
    BOXN,   // Open wagon: Coal, Iron Ore, Stone
    BOBRN,  // Bottom discharge hopper: Power-plant bulk coal
    BCN,    // Covered wagon: Bagged cement, foodgrains, fertilizer
    BTPN,   // Tank wagon: POL / liquid fuels
}

/// Commodity types hauled in the freight network.
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
            (WagonStockType::BOXN, Commodity::ThermalCoal) => true,
            (WagonStockType::BOXN, Commodity::CokingCoal) => true,
            (WagonStockType::BOXN, Commodity::IronOre) => true,
            (WagonStockType::BOBRN, Commodity::ThermalCoal) => true,
            (WagonStockType::BOBRN, Commodity::CokingCoal) => true,
            (WagonStockType::BCN, Commodity::BaggedCement) => true,
            (WagonStockType::BCN, Commodity::FoodGrain) => true,
            (WagonStockType::BTPN, Commodity::PetroleumProduct) => true,
            _ => false,
        }
    }
}

/// Node in the time-expanded graph: a specific terminal at a specific time bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TimeExpandedNode {
    pub terminal_id: TerminalId,
    pub time_bucket: TimeBucket,
}

/// Type and operational characteristics of a transition arc in the network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ArcKind {
    /// Moving loaded to fulfill an indent/order between origin and destination terminals.
    LoadedMovement {
        demand_id: usize,
        commodity: Commodity,
        origin_terminal: TerminalId,
        dest_terminal: TerminalId,
    },
    /// Repositioning empty rake from surplus terminal to deficit terminal.
    EmptyRepositioning {
        origin_terminal: TerminalId,
        dest_terminal: TerminalId,
        empty_distance_km: f64,
    },
    /// Idling/dwelling at yard sidings awaiting loading, dispatch, or assignment.
    StationaryDwell {
        terminal_id: TerminalId,
        detention_cost_per_hour: f64,
    },
    /// Undergoing mandatory post-trip examination / servicing turnaround (Constraint 5).
    ServicingTurnaround {
        terminal_id: TerminalId,
        required_duration_buckets: u32,
    },
    /// Pre-scheduled track / rolling stock maintenance window (Constraint 6: rakes removed from pool).
    ScheduledMaintenance {
        terminal_id: TerminalId,
        work_order_id: usize,
    },
}

/// Arc connecting two time-expanded nodes representing rake traversal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeExpandedArc {
    pub arc_id: usize,
    pub from_node: TimeExpandedNode,
    pub to_node: TimeExpandedNode,
    pub kind: ArcKind,
    pub distance_km: f64,
    pub transit_time_buckets: u32,
    /// Physical railway section ID for section-capacity enforcement (Constraint 3).
    pub section_id: Option<usize>,
    /// Compatible rake stock types that can traverse this arc.
    pub allowed_stock_types: Vec<WagonStockType>,
}

/// Operational capacity metrics for a terminal at a given time bucket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalCapacity {
    pub terminal_id: TerminalId,
    pub time_bucket: TimeBucket,
    /// Maximum simultaneous rakes that can be loaded in this bucket (Constraint 2).
    pub max_loading_rakes: usize,
    /// Maximum simultaneous rakes that can be unloaded in this bucket (Constraint 2).
    pub max_unloading_rakes: usize,
    /// Yard track storage capacity for dwelling rakes.
    pub max_dwell_capacity: usize,
}

/// Dynamic section track capacity (max rakes in transit per time bucket on a rail corridor).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCapacity {
    pub section_id: usize,
    pub from_terminal: TerminalId,
    pub to_terminal: TerminalId,
    pub max_simultaneous_rakes: usize,
}

/// Freight transport demand order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportDemand {
    pub demand_id: usize,
    pub origin_terminal: TerminalId,
    pub dest_terminal: TerminalId,
    pub commodity: Commodity,
    pub quantity_rakes: usize,
    pub release_time_bucket: TimeBucket,
    pub due_time_bucket: TimeBucket,
    /// Penalty weight for unserved demand in objective function.
    pub penalty_unserved_weight: f64,
    /// Penalty per bucket of delivery lateness past due_time_bucket.
    pub lateness_penalty_per_bucket: f64,
}

/// Scheduled maintenance window removing a specific rake or capacity from the pool (Constraint 6).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceWindow {
    pub maintenance_id: usize,
    pub rake_id: usize,
    pub terminal_id: TerminalId,
    pub start_bucket: TimeBucket,
    pub end_bucket: TimeBucket,
}

/// The complete Time-Expanded Network Graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeExpandedGraph {
    pub horizon_buckets: TimeBucket,
    pub terminal_count: usize,
    pub nodes: Vec<TimeExpandedNode>,
    pub arcs: Vec<TimeExpandedArc>,
    /// Fast forward-star indexing: Node -> Vec<ArcId>
    pub forward_star: HashMap<TimeExpandedNode, Vec<usize>>,
    /// Fast reverse-star indexing: Node -> Vec<ArcId>
    pub reverse_star: HashMap<TimeExpandedNode, Vec<usize>>,
    /// Terminal capacities indexed by (terminal, time_bucket)
    pub terminal_capacities: HashMap<(TerminalId, TimeBucket), TerminalCapacity>,
    /// Section capacities
    pub section_capacities: HashMap<usize, SectionCapacity>,
    /// Active transport demands
    pub demands: Vec<TransportDemand>,
    /// Mandatory scheduled maintenance windows
    pub maintenance_windows: Vec<MaintenanceWindow>,
    /// Minimum turnaround servicing buckets by terminal (Constraint 5)
    pub min_servicing_buckets: HashMap<TerminalId, u32>,
}

impl TimeExpandedGraph {
    pub fn new(horizon_buckets: TimeBucket, terminal_count: usize) -> Self {
        let mut nodes = Vec::new();
        for t in 0..terminal_count {
            for b in 0..=horizon_buckets {
                nodes.push(TimeExpandedNode {
                    terminal_id: t,
                    time_bucket: b,
                });
            }
        }

        Self {
            horizon_buckets,
            terminal_count,
            nodes,
            arcs: Vec::new(),
            forward_star: HashMap::new(),
            reverse_star: HashMap::new(),
            terminal_capacities: HashMap::new(),
            section_capacities: HashMap::new(),
            demands: Vec::new(),
            maintenance_windows: Vec::new(),
            min_servicing_buckets: HashMap::new(),
        }
    }

    /// Adds an arc and updates forward/reverse adjacency lists.
    pub fn add_arc(&mut self, arc: TimeExpandedArc) {
        let id = arc.arc_id;
        let from = arc.from_node;
        let to = arc.to_node;
        self.arcs.push(arc);
        self.forward_star.entry(from).or_default().push(id);
        self.reverse_star.entry(to).or_default().push(id);
    }

    /// Retrieve outgoing arcs from a node.
    pub fn outgoing_arcs(&self, node: &TimeExpandedNode) -> &[usize] {
        self.forward_star.get(node).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Retrieve incoming arcs to a node.
    pub fn incoming_arcs(&self, node: &TimeExpandedNode) -> &[usize] {
        self.reverse_star.get(node).map(|v| v.as_slice()).unwrap_or(&[])
    }
}
