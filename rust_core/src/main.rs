//! PRJ 287 CLI Demonstration: Rake Allocation Engine LNS Benchmark

use prj287_rake_allocation_engine::*;
use std::collections::HashMap;

fn main() {
    println!("===============================================================");
    println!("  PRJ 287: STOCHASTIC RAKE ALLOCATION ENGINE (LNS + CP-SAT)");
    println!("===============================================================");

    let horizon = 36; // 36 hours horizon (1-hour time buckets)
    let terminal_count = 5; // Terminals: 0=Mines, 1=Washery, 2=Thermal Plant A, 3=Port, 4=Cement Plant
    let mut graph = TimeExpandedGraph::new(horizon, terminal_count);

    // Minimum servicing buckets per terminal (Constraint 5)
    graph.min_servicing_buckets.insert(0, 2); // 2 hours
    graph.min_servicing_buckets.insert(1, 2);
    graph.min_servicing_buckets.insert(2, 3); // Unloading + turnback
    graph.min_servicing_buckets.insert(3, 3);
    graph.min_servicing_buckets.insert(4, 2);

    // Setup terminal loading/unloading capacities (Constraint 2)
    for t in 0..terminal_count {
        for b in 0..=horizon {
            graph.terminal_capacities.insert(
                (t, b),
                TerminalCapacity {
                    terminal_id: t,
                    time_bucket: b,
                    max_loading_rakes: if t == 0 || t == 1 { 3 } else { 1 },
                    max_unloading_rakes: if t == 2 || t == 3 { 3 } else { 1 },
                    max_dwell_capacity: 8,
                },
            );
        }
    }

    // Setup section capacities (Constraint 3)
    graph.section_capacities.insert(
        101, // Main Corridor: Mines <-> Thermal Plant
        SectionCapacity {
            section_id: 101,
            from_terminal: 0,
            to_terminal: 2,
            max_simultaneous_rakes: 4,
        },
    );
    graph.section_capacities.insert(
        102, // Port Line
        SectionCapacity {
            section_id: 102,
            from_terminal: 0,
            to_terminal: 3,
            max_simultaneous_rakes: 3,
        },
    );

    // Build Time-Expanded Arcs: Dwell arcs at each terminal
    let mut arc_counter = 0;
    for t in 0..terminal_count {
        for b in 0..horizon {
            graph.add_arc(TimeExpandedArc {
                arc_id: arc_counter,
                from_node: TimeExpandedNode { terminal_id: t, time_bucket: b },
                to_node: TimeExpandedNode { terminal_id: t, time_bucket: b + 1 },
                kind: ArcKind::StationaryDwell {
                    terminal_id: t,
                    detention_cost_per_hour: 15.0,
                },
                distance_km: 0.0,
                transit_time_buckets: 1,
                section_id: None,
                allowed_stock_types: vec![
                    WagonStockType::BOXN,
                    WagonStockType::BOBRN,
                    WagonStockType::BCN,
                ],
            });
            arc_counter += 1;
        }
    }

    // Transit arcs between terminals (e.g. Mines -> Thermal Plant: 4 buckets)
    for b in 0..horizon.saturating_sub(4) {
        // Loaded movement
        graph.add_arc(TimeExpandedArc {
            arc_id: arc_counter,
            from_node: TimeExpandedNode { terminal_id: 0, time_bucket: b },
            to_node: TimeExpandedNode { terminal_id: 2, time_bucket: b + 4 },
            kind: ArcKind::LoadedMovement {
                demand_id: 0,
                commodity: Commodity::ThermalCoal,
                origin_terminal: 0,
                dest_terminal: 2,
            },
            distance_km: 240.0,
            transit_time_buckets: 4,
            section_id: Some(101),
            allowed_stock_types: vec![WagonStockType::BOXN, WagonStockType::BOBRN],
        });
        arc_counter += 1;

        // Empty repositioning (Return trip: 3 buckets)
        graph.add_arc(TimeExpandedArc {
            arc_id: arc_counter,
            from_node: TimeExpandedNode { terminal_id: 2, time_bucket: b },
            to_node: TimeExpandedNode { terminal_id: 0, time_bucket: b + 3 },
            kind: ArcKind::EmptyRepositioning {
                origin_terminal: 2,
                dest_terminal: 0,
                empty_distance_km: 240.0,
            },
            distance_km: 240.0,
            transit_time_buckets: 3,
            section_id: Some(101),
            allowed_stock_types: vec![WagonStockType::BOXN, WagonStockType::BOBRN],
        });
        arc_counter += 1;
    }

    // Scheduled maintenance windows (Constraint 6)
    graph.maintenance_windows.push(MaintenanceWindow {
        maintenance_id: 1,
        rake_id: 3, // Rake #3 must enter depot at terminal 1 for inspection
        terminal_id: 1,
        start_bucket: 12,
        end_bucket: 18,
    });

    // Transport demands
    graph.demands.push(TransportDemand {
        demand_id: 101,
        origin_terminal: 0,
        dest_terminal: 2,
        commodity: Commodity::ThermalCoal,
        quantity_rakes: 4,
        release_time_bucket: 2,
        due_time_bucket: 14,
        penalty_unserved_weight: 10000.0,
        lateness_penalty_per_bucket: 300.0,
    });
    graph.demands.push(TransportDemand {
        demand_id: 102,
        origin_terminal: 0,
        dest_terminal: 3,
        commodity: Commodity::IronOre,
        quantity_rakes: 3,
        release_time_bucket: 6,
        due_time_bucket: 20,
        penalty_unserved_weight: 8000.0,
        lateness_penalty_per_bucket: 250.0,
    });

    // Fleet initialization: 12 rakes
    let mut fleet = Vec::new();
    for r in 0..12 {
        fleet.push(RakeAsset {
            rake_id: r,
            stock_type: if r < 6 { WagonStockType::BOBRN } else if r < 10 { WagonStockType::BOXN } else { WagonStockType::BCN },
            initial_terminal: r % terminal_count,
            initial_available_bucket: 0,
        });
    }

    // Build baseline schedule (idling along dwell arcs)
    let mut initial_schedule = IncumbentSchedule::new(fleet.clone());
    for rake in &fleet {
        let mut path = Vec::new();
        // Trace dwell arcs at initial terminal
        let mut cur_node = TimeExpandedNode {
            terminal_id: rake.initial_terminal,
            time_bucket: 0,
        };
        for _ in 0..horizon {
            let arcs = graph.outgoing_arcs(&cur_node);
            if let Some(&dwell_arc_id) = arcs.iter().find(|&&id| matches!(graph.arcs[id].kind, ArcKind::StationaryDwell { .. })) {
                path.push(dwell_arc_id);
                cur_node = graph.arcs[dwell_arc_id].to_node;
            }
        }
        initial_schedule.rake_paths.insert(rake.rake_id, path);
    }
    for (&rake_id, path) in &initial_schedule.rake_paths {
        for &arc_id in path {
            initial_schedule.arc_flows.entry(arc_id).or_default().push(rake_id);
        }
    }

    let weights = ObjectiveWeights::default();
    let config = LnsConfig {
        max_iterations: 30,
        max_stagnant_iterations: 15,
        time_window_duration: 8,
        ..Default::default()
    };

    println!("Total Time-Expanded Nodes: {}", graph.nodes.len());
    println!("Total Time-Expanded Arcs: {}", graph.arcs.len());
    println!("Total Fleet Rakes: {}", fleet.len());
    println!("Total Demands: {}", graph.demands.len());

    let result = run_lns_rake_allocation(initial_schedule, &graph, &weights, &config).expect("LNS failed");

    println!("\n=== Optimization Summary ===");
    println!("Initial Cost: {:.2}", result.initial_score.total_weighted_cost);
    println!("Final Cost:   {:.2}", result.final_score.total_weighted_cost);
    println!("Unserved Demands: {}", result.final_score.unserved_demands_count);
    println!("Empty Km: {:.1}", result.final_score.total_empty_km);
    println!("Detention Hours: {:.1}", result.final_score.total_detention_hours);
    println!("Feasibility Guaranteed: {}", result.feasibility_report.is_feasible);
}
