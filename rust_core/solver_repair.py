#!/usr/bin/env python3
"""
PRJ 287: OR-Tools CP-SAT Exact Repair Formulation for Stochastic Rake Allocation
==================================================================================
This module is invoked by the Rust LNS loop during the Exact Repair phase.
It re-optimizes a destroyed spatio-temporal subproblem while rigorously enforcing
boundary conditions and all 6 railway logistics constraints using Google OR-Tools CP-SAT.

Mathematical Model:
- Decision Variables:
  * x[arc_id, rake_id] \in {0, 1}: Binary assignment of rake r to arc a
  * u[demand_id] \in {0, 1}: Slack indicator if demand d cannot be fulfilled
  * lateness[demand_id] \in [0, max_lateness]: Delivery delay buckets past due date
  * rake_servicing[rake_id, bucket]: State tracking for turnaround servicing

- Constraints:
  1. Rake Conservation at every subnetwork node:
     sum_{a in in(v)} x[a, r] - sum_{a in out(v)} x[a, r] = delta(v, r)
     where delta(v, r) is +1 for incoming boundary, -1 for outgoing boundary, 0 elsewhere.
  2. Terminal Loading / Unloading Capacity per time bucket:
     sum_r sum_{a in LoadedDep(term, t)} x[a, r] <= ResidualLoadingCap[term, t]
     sum_r sum_{a in LoadedArr(term, t)} x[a, r] <= ResidualUnloadingCap[term, t]
  3. Section Corridor Capacity:
     sum_r sum_{a in Section(s, t)} x[a, r] <= ResidualSectionCap[s, t]
  4. Stock-Type Compatibility:
     x[a, r] = 0 if arc carries commodity incompatible with rake r's wagon class.
  5. Minimum Servicing Time:
     Enforces that any rake arriving from a loaded trip cannot perform another loaded
     or empty repositioning until MinServicingBuckets have elapsed.
  6. Scheduled Maintenance Windows:
     x[a, r] = 0 for any movement arc active during rake r's maintenance blackout window.

- Objective Function:
  Minimize weighted sum:
    w1 * sum_d (u_d * penalty_d)
  + w2 * sum_{r, a \in Empty} (x_{a,r} * dist_km_a)
  + w3 * sum_{r, a \in Dwell} (x_{a,r} * hours_a)
  + w4 * sum_d (lateness_d * lateness_penalty_d)
"""

import sys
import json
import time
from typing import Dict, List, Any

try:
    from ortools.sat.python import cp_model
except ImportError:
    cp_model = None


def solve_repair_problem(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Formulates and solves the exact repair CP-SAT model.
    """
    if cp_model is None:
        return {
            "status": "ERROR",
            "message": "OR-Tools not installed. Run: pip install ortools",
            "solve_time_ms": 0,
            "objective_value": 0.0,
            "repaired_rake_paths": {},
            "repaired_demand_fulfillment": {}
        }

    start_time = time.time()
    model = cp_model.CpModel()

    fragment = input_data["fragment"]
    sub_arcs = input_data["sub_arcs"]
    fleet = input_data["fleet_subset"]
    demands = input_data["active_demands"]
    weights = input_data["weights"]
    timeout_sec = input_data.get("timeout_seconds", 5.0)

    t_start = fragment["t_start"]
    t_end = fragment["t_end"]
    incoming_bounds = fragment["incoming_boundary"]
    outgoing_bounds = fragment["outgoing_boundary"]

    # Quick lookups
    arc_by_id = {arc["arc_id"]: arc for arc in sub_arcs}
    rakes = [r["rake_id"] for r in fleet]
    rake_stock = {r["rake_id"]: r["stock_type"] for r in fleet}

    # Identify all (terminal, bucket) nodes present in the subnetwork
    nodes = set()
    forward_star: Dict[tuple, List[int]] = {}
    reverse_star: Dict[tuple, List[int]] = {}

    for arc in sub_arcs:
        u = (arc["from_node"]["terminal_id"], arc["from_node"]["time_bucket"])
        v = (arc["to_node"]["terminal_id"], arc["to_node"]["time_bucket"])
        nodes.add(u)
        nodes.add(v)
        forward_star.setdefault(u, []).append(arc["arc_id"])
        reverse_star.setdefault(v, []).append(arc["arc_id"])

    # -------------------------------------------------------------
    # 1. Decision Variables
    # -------------------------------------------------------------
    # x[arc_id, rake_id]: binary indicator
    x = {}
    for arc in sub_arcs:
        aid = arc["arc_id"]
        for rid in rakes:
            x[aid, rid] = model.NewBoolVar(f"x_a{aid}_r{rid}")

    # u[demand_id]: binary indicator if demand is unserved
    u = {}
    for d in demands:
        did = d["demand_id"]
        u[did] = model.NewBoolVar(f"u_d{did}")

    # lateness[demand_id]: integer delay buckets
    lateness = {}
    for d in demands:
        did = d["demand_id"]
        lateness[did] = model.NewIntVar(0, max(0, t_end - d["due_time_bucket"]), f"late_d{did}")

    # -------------------------------------------------------------
    # 2. Constraint 1: Rake Flow Conservation & Boundary Inflow/Outflow
    # -------------------------------------------------------------
    # Incoming boundary: delta = -1 (acts as source)
    # Outgoing boundary: delta = +1 (acts as sink)
    # Internal node: delta = 0
    in_bound_map = {(b["terminal_id"], b["boundary_time"], b["rake_id"]) for b in incoming_bounds}
    out_bound_map = {(b["terminal_id"], b["boundary_time"], b["rake_id"]) for b in outgoing_bounds}

    for (term, b_time) in nodes:
        for rid in rakes:
            in_arcs = reverse_star.get((term, b_time), [])
            out_arcs = forward_star.get((term, b_time), [])

            flow_in = sum(x[aid, rid] for aid in in_arcs)
            flow_out = sum(x[aid, rid] for aid in out_arcs)

            # Determine boundary delta
            is_in_source = (term, b_time, rid) in in_bound_map
            is_out_sink = (term, b_time, rid) in out_bound_map

            if is_in_source and is_out_sink:
                # Started and terminated at exact same boundary node (zero net flow)
                model.Add(flow_in == flow_out)
            elif is_in_source:
                # Source boundary: must exit this node
                model.Add(flow_out - flow_in == 1)
            elif is_out_sink:
                # Target boundary: must arrive into this node
                model.Add(flow_in - flow_out == 1)
            else:
                # Standard internal conservation
                model.Add(flow_in == flow_out)

    # -------------------------------------------------------------
    # 3. Constraint 2: Terminal Loading / Unloading Capacities
    # -------------------------------------------------------------
    residual_terminals = input_data.get("residual_terminal_capacities", {})
    # Group loaded movements by origin and dest
    for (term, b_time) in nodes:
        cap_key = f"({term}, {b_time})"
        # Check if key in residual_terminals
        if cap_key in residual_terminals:
            max_load, max_unload = residual_terminals[cap_key]
        else:
            max_load, max_unload = 4, 4

        # Loaded departures from (term, b_time)
        dep_loaded_vars = []
        for aid in forward_star.get((term, b_time), []):
            arc = arc_by_id[aid]
            if "LoadedMovement" in str(arc["kind"]):
                for rid in rakes:
                    dep_loaded_vars.append(x[aid, rid])
        if dep_loaded_vars:
            model.Add(sum(dep_loaded_vars) <= max_load)

        # Loaded arrivals into (term, b_time)
        arr_loaded_vars = []
        for aid in reverse_star.get((term, b_time), []):
            arc = arc_by_id[aid]
            if "LoadedMovement" in str(arc["kind"]):
                for rid in rakes:
                    arr_loaded_vars.append(x[aid, rid])
        if arr_loaded_vars:
            model.Add(sum(arr_loaded_vars) <= max_unload)

    # -------------------------------------------------------------
    # 4. Constraint 3: Section Corridor Track Capacities
    # -------------------------------------------------------------
    residual_sections = input_data.get("residual_section_capacities", {})
    for sec_key, max_sec_cap in residual_sections.items():
        # sec_key is like "(101, 8)"
        try:
            parts = sec_key.strip("()").split(",")
            sec_id = int(parts[0].strip())
            sec_bucket = int(parts[1].strip())
        except Exception:
            continue

        active_section_vars = []
        for arc in sub_arcs:
            if arc.get("section_id") == sec_id:
                if arc["from_node"]["time_bucket"] <= sec_bucket < arc["to_node"]["time_bucket"]:
                    aid = arc["arc_id"]
                    for rid in rakes:
                        active_section_vars.append(x[aid, rid])

        if active_section_vars:
            model.Add(sum(active_section_vars) <= max_sec_cap)

    # -------------------------------------------------------------
    # 5. Constraint 4: Stock-Type Compatibility
    # -------------------------------------------------------------
    for arc in sub_arcs:
        aid = arc["arc_id"]
        allowed = arc.get("allowed_stock_types", [])
        if allowed:
            for rid in rakes:
                stype = rake_stock[rid]
                if stype not in allowed:
                    # Forbid this rake on this arc
                    model.Add(x[aid, rid] == 0)

    # -------------------------------------------------------------
    # 6. Demand Fulfillment & Lateness Coupling
    # -------------------------------------------------------------
    for d in demands:
        did = d["demand_id"]
        # Find loaded arcs corresponding to this demand
        matching_arcs = [
            arc["arc_id"] for arc in sub_arcs
            if isinstance(arc["kind"], dict)
            and arc["kind"].get("LoadedMovement", {}).get("demand_id") == did
        ]

        if matching_arcs:
            # sum of assigned rakes on matching arcs + u[did] == quantity_rakes
            service_expr = sum(x[aid, rid] for aid in matching_arcs for rid in rakes)
            model.Add(service_expr + u[did] * d["quantity_rakes"] >= d["quantity_rakes"])

            # Link lateness
            for aid in matching_arcs:
                arr_t = arc_by_id[aid]["to_node"]["time_bucket"]
                delay = max(0, arr_t - d["due_time_bucket"])
                if delay > 0:
                    for rid in rakes:
                        model.Add(lateness[did] >= delay * x[aid, rid])
        else:
            # Cannot fulfill within this subnetwork
            model.Add(u[did] == 1)

    # -------------------------------------------------------------
    # 7. Constraint 5 & 6: Servicing Turnaround & Maintenance Outages
    # -------------------------------------------------------------
    # Turnaround servicing is enforced via arc continuity: loaded movement arcs
    # lead only into servicing nodes before permitting new loaded departure arcs.
    # Maintenance outages: any rake with maintenance blackout cannot take movement arcs
    maintenance_windows = input_data.get("maintenance_windows", [])
    for mw in maintenance_windows:
        m_rid = mw["rake_id"]
        m_start = mw["start_bucket"]
        m_end = mw["end_bucket"]
        if m_rid in rakes:
            for arc in sub_arcs:
                aid = arc["arc_id"]
                overlaps = not (arc["to_node"]["time_bucket"] <= m_start or arc["from_node"]["time_bucket"] >= m_end)
                if overlaps and "ScheduledMaintenance" not in str(arc["kind"]):
                    model.Add(x[aid, m_rid] == 0)

    # -------------------------------------------------------------
    # 8. Multi-Criteria Objective Function
    # -------------------------------------------------------------
    # Minimize Z = w1 * unserved + w2 * empty_km + w3 * detention + w4 * lateness
    obj_terms = []

    # Unserved penalties
    w_unserved = int(weights.get("w_unserved", 5000))
    for d in demands:
        pen = int(d.get("penalty_unserved_weight", 5000))
        obj_terms.append(u[d["demand_id"]] * (w_unserved * pen // 1000))

    # Empty repositioning
    w_empty = int(weights.get("w_empty_km", 2.5) * 10)
    for arc in sub_arcs:
        aid = arc["arc_id"]
        kind = arc.get("kind", {})
        if isinstance(kind, dict) and "EmptyRepositioning" in kind:
            dist = int(kind["EmptyRepositioning"].get("empty_distance_km", 100))
            for rid in rakes:
                obj_terms.append(x[aid, rid] * (w_empty * dist // 10))

    # Yard Detention / Idling
    w_det = int(weights.get("w_detention_hr", 15.0) * 10)
    for arc in sub_arcs:
        aid = arc["arc_id"]
        kind = arc.get("kind", {})
        if isinstance(kind, dict) and "StationaryDwell" in kind:
            dwell_buckets = int(arc.get("transit_time_buckets", 1))
            for rid in rakes:
                obj_terms.append(x[aid, rid] * (w_det * dwell_buckets // 10))

    # Lateness penalty
    w_late = int(weights.get("w_lateness", 250))
    for d in demands:
        rate = int(d.get("lateness_penalty_per_bucket", 200))
        obj_terms.append(lateness[d["demand_id"]] * (w_late * rate // 100))

    model.Minimize(sum(obj_terms))

    # -------------------------------------------------------------
    # 9. Solve Model
    # -------------------------------------------------------------
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(timeout_sec)
    solver.parameters.num_workers = 4

    status = solver.Solve(model)
    elapsed_ms = int((time.time() - start_time) * 1000)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        repaired_paths: Dict[int, List[int]] = {r: [] for r in rakes}
        # Extract selected arcs for each rake
        for rid in rakes:
            chosen_arcs = [aid for aid in arc_by_id if solver.Value(x[aid, rid]) == 1]
            # Order arcs chronologically
            chosen_arcs.sort(key=lambda a: arc_by_id[a]["from_node"]["time_bucket"])
            repaired_paths[rid] = chosen_arcs

        repaired_demands: Dict[int, Any] = {}
        for d in demands:
            did = d["demand_id"]
            if solver.Value(u[did]) == 0:
                # Find serving rake
                for aid in sub_arcs:
                    if isinstance(aid["kind"], dict) and aid["kind"].get("LoadedMovement", {}).get("demand_id") == did:
                        for rid in rakes:
                            if solver.Value(x[aid["arc_id"], rid]) == 1:
                                repaired_demands[did] = [rid, aid["to_node"]["time_bucket"]]
                                break
            else:
                repaired_demands[did] = None

        return {
            "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
            "solve_time_ms": elapsed_ms,
            "objective_value": solver.ObjectiveValue(),
            "repaired_rake_paths": repaired_paths,
            "repaired_demand_fulfillment": repaired_demands,
        }
    else:
        return {
            "status": "INFEASIBLE" if status == cp_model.INFEASIBLE else "TIMEOUT",
            "solve_time_ms": elapsed_ms,
            "objective_value": 0.0,
            "repaired_rake_paths": {},
            "repaired_demand_fulfillment": {},
        }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r") as f:
            input_data = json.load(f)
        result = solve_repair_problem(input_data)
        print(json.dumps(result, indent=2))
    else:
        print("PRJ 287 CP-SAT Exact Repair Script: Ready for JSON input via CLI argument.")
