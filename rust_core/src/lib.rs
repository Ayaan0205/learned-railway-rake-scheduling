//! PRJ 287: Stochastic Rake Allocation Engine - Solver Core & Exact Repair Module
//! 
//! Provides:
//! - Time-Expanded Graph Data Structures (`graph`)
//! - Incumbent Schedule & Multi-Criteria Objective Evaluator (`schedule`)
//! - Handcrafted Destroy Operators & Boundary Condition Extractor (`destroy`)
//! - OR-Tools CP-SAT Exact Repair Bridge (`cp_sat_bridge`)
//! - LNS State Manager (`lns_state`)
//! - LNS Execution Loop (`lns_loop`)

pub mod graph;
pub mod schedule;
pub mod destroy;
pub mod cp_sat_bridge;
pub mod lns_state;
pub mod lns_loop;

pub use graph::*;
pub use schedule::*;
pub use destroy::*;
pub use cp_sat_bridge::*;
pub use lns_state::*;
pub use lns_loop::*;
