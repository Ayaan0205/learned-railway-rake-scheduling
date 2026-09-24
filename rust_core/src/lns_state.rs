//! LNS State Manager & Metaheuristic Convergence Tracking for PRJ 287

use crate::destroy::DestroyOperatorKind;
use crate::schedule::{IncumbentSchedule, ObjectiveScore, ObjectiveWeights};
use serde::{Deserialize, Serialize};

/// Record of an individual iteration in the LNS search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnsIterationLog {
    pub iteration: usize,
    pub operator: DestroyOperatorKind,
    pub candidate_cost: f64,
    pub incumbent_cost: f64,
    pub best_cost: f64,
    pub accepted: bool,
    pub is_new_best: bool,
    pub temperature: f64,
    pub score_breakdown: ObjectiveScore,
    pub solve_duration_ms: u64,
}

/// Acceptance strategy for candidate solutions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AcceptanceCriterion {
    /// Simulated Annealing: P(accept) = exp(-Δ / T)
    SimulatedAnnealing {
        initial_temperature: f64,
        cooling_rate: f64, // e.g. 0.985
        current_temperature: f64,
    },
    /// Strict descent (only accept strictly better candidates)
    StrictImprovementOnly,
    /// Threshold Acceptance: accept if Δ <= current_threshold
    ThresholdAcceptance {
        current_threshold: f64,
        decay_rate: f64,
    },
}

/// Statistics on destroy operator efficacy.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OperatorStats {
    pub invocations: usize,
    pub improvements: usize,
    pub best_found_count: usize,
    pub total_cost_reduction: f64,
}

/// LNS State Manager holding global incumbent, search history, and operator telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LnsStateManager {
    pub incumbent: IncumbentSchedule,
    pub best_solution: IncumbentSchedule,
    pub initial_cost: f64,
    pub best_cost: f64,
    pub current_iteration: usize,
    pub max_iterations: usize,
    pub consecutive_stagnant_iterations: usize,
    pub acceptance_strategy: AcceptanceCriterion,
    pub operator_stats: std::collections::HashMap<DestroyOperatorKind, OperatorStats>,
    pub iteration_history: Vec<LnsIterationLog>,
    pub weights: ObjectiveWeights,
}

impl LnsStateManager {
    pub fn new(
        initial_solution: IncumbentSchedule,
        weights: ObjectiveWeights,
        max_iterations: usize,
        initial_temp: f64,
        cooling_rate: f64,
    ) -> Self {
        let initial_cost = initial_solution.score.total_weighted_cost;
        let mut operator_stats = std::collections::HashMap::new();
        operator_stats.insert(DestroyOperatorKind::RandomTimeWindow, OperatorStats::default());
        operator_stats.insert(DestroyOperatorKind::GeographicCluster, OperatorStats::default());
        operator_stats.insert(DestroyOperatorKind::HighDetentionTargeted, OperatorStats::default());

        Self {
            incumbent: initial_solution.clone(),
            best_solution: initial_solution,
            initial_cost,
            best_cost: initial_cost,
            current_iteration: 0,
            max_iterations,
            consecutive_stagnant_iterations: 0,
            acceptance_strategy: AcceptanceCriterion::SimulatedAnnealing {
                initial_temperature: initial_temp,
                cooling_rate,
                current_temperature: initial_temp,
            },
            operator_stats,
            iteration_history: Vec::new(),
            weights,
        }
    }

    /// Evaluates acceptance of a candidate solution and updates state.
    pub fn consider_candidate(
        &mut self,
        candidate: IncumbentSchedule,
        operator: DestroyOperatorKind,
        solve_ms: u64,
        rng: &mut impl rand::Rng,
    ) -> bool {
        self.current_iteration += 1;
        let candidate_cost = candidate.score.total_weighted_cost;
        let current_incumbent_cost = self.incumbent.score.total_weighted_cost;
        let delta = candidate_cost - current_incumbent_cost;

        let (accepted, temp) = match &mut self.acceptance_strategy {
            AcceptanceCriterion::SimulatedAnnealing { current_temperature, cooling_rate, .. } => {
                let accept = if delta <= 0.0 {
                    true
                } else {
                    let prob = (-delta / *current_temperature).exp();
                    rng.gen::<f64>() < prob
                };
                let t = *current_temperature;
                *current_temperature *= *cooling_rate;
                (accept, t)
            }
            AcceptanceCriterion::StrictImprovementOnly => (delta < 0.0, 0.0),
            AcceptanceCriterion::ThresholdAcceptance { current_threshold, decay_rate } => {
                let accept = delta <= *current_threshold;
                let thresh = *current_threshold;
                *current_threshold *= *decay_rate;
                (accept, thresh)
            }
        };

        let mut is_new_best = false;
        let op_stat = self.operator_stats.entry(operator).or_default();
        op_stat.invocations += 1;

        if accepted {
            if candidate_cost < current_incumbent_cost {
                op_stat.improvements += 1;
                op_stat.total_cost_reduction += current_incumbent_cost - candidate_cost;
            }

            if candidate_cost < self.best_cost {
                self.best_cost = candidate_cost;
                self.best_solution = candidate.clone();
                self.consecutive_stagnant_iterations = 0;
                is_new_best = true;
                op_stat.best_found_count += 1;
            } else {
                self.consecutive_stagnant_iterations += 1;
            }

            self.incumbent = candidate;
        } else {
            self.consecutive_stagnant_iterations += 1;
        }

        self.iteration_history.push(LnsIterationLog {
            iteration: self.current_iteration,
            operator,
            candidate_cost,
            incumbent_cost: self.incumbent.score.total_weighted_cost,
            best_cost: self.best_cost,
            accepted,
            is_new_best,
            temperature: temp,
            score_breakdown: self.incumbent.score.clone(),
            solve_duration_ms: solve_ms,
        });

        accepted
    }

    /// Checks if search termination condition has been reached.
    pub fn should_terminate(&self, max_stagnant: usize) -> bool {
        self.current_iteration >= self.max_iterations
            || self.consecutive_stagnant_iterations >= max_stagnant
    }
}
