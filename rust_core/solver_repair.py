#!/usr/bin/env python3
"""
PRJ 287: OR-Tools CP-SAT Exact Repair Formulation for Railway Rake Allocation
==============================================================================
This module solves a destroyed spatio-temporal subproblem using Google OR-Tools
CP-SAT. It receives a JSON payload describing the destroyed neighborhood and
boundary conditions, builds a constraint satisfaction model, and returns the
optimized repair solution.

Compatible with both the Rust-native JSON format and the TypeScript frontend
JSON format (where arc.kind = { type: "LoadedMovement", ... }).
"""

import sys
import json
import time
from typing import Dict, List, Any, Optional, Tuple

try:
    from ortools.sat.python import cp_model
except ImportError:
    cp_model = None


# ─── Arc kind helpers (handle both Rust and TS JSON formats) ──────────────────

def get_arc_type(arc: dict) -> str:
    """Extract arc type string from either format."""
    kind = arc.get("kind", {})
    if isinstance(kind, dict):
        if "type" in kind:
            return kind["type"]  # TS format: { type: "LoadedMovement", ... }
        # Rust format: { "LoadedMovement": { ... } }
        for key in ["LoadedMovement", "EmptyRepositioning", "StationaryDwell",
                     "ServicingTurnaround", "ScheduledMaintenance"]:
            if key in kind:
                return key
    return str(kind)


def get_arc_demand_id(arc: dict) -> Optional[int]:
    """Extract demand_id from a LoadedMovement arc."""
    kind = arc.get("kind", {})
    if isinstance(kind, dict):
        if kind.get("type") == "LoadedMovement":
            return kind.get("demand_id")
        if "LoadedMovement" in kind:
            return kind["LoadedMovement"].get("demand_id")
    return None


def get_arc_empty_km(arc: dict) -> float:
    """Extract empty_distance_km from an EmptyRepositioning arc."""
    kind = arc.get("kind", {})
    if isinstance(kind, dict):
        if kind.get("type") == "EmptyRepositioning":
            return float(kind.get("empty_distance_km", 100))
        if "EmptyRepositioning" in kind:
            return float(kind["EmptyRepositioning"].get("empty_distance_km", 100))
    return 100.0


def get_arc_dwell_buckets(arc: dict) -> int:
    """Extract transit time for dwell cost calculation."""
    return int(arc.get("transit_time_buckets", 1))


def is_loaded_movement(arc: dict) -> bool:
    return get_arc_type(arc) == "LoadedMovement"


def is_empty_repositioning(arc: dict) -> bool:
    return get_arc_type(arc) == "EmptyRepositioning"


def is_stationary_dwell(arc: dict) -> bool:
    return get_arc_type(arc) == "StationaryDwell"


def is_scheduled_maintenance(arc: dict) -> bool:
    return get_arc_type(arc) == "ScheduledMaintenance"


# ─── Main CP-SAT Solver ──────────────────────────────────────────────────────

def solve_repair_problem(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Formulates and solves the exact repair CP-SAT model for a destroyed
    spatio-temporal subproblem.
    
    Input:
      - fragment: { t_start, t_end, incoming_boundary, outgoing_boundary, ... }
      - sub_arcs: list of arcs within the destroyed region
      - fleet_subset: list of rakes active in this region
      - active_demands: list of demands to consider
      - weights: { w_unserved, w_empty_km, w_detention_hr, w_lateness }
      - timeout_seconds: solver time limit (default 5.0)
      - maintenance_windows: list of maintenance constraints
      - residual_terminal_capacities: dict of residual caps
      - residual_section_capacities: dict of residual section caps
    
    Output:
      - status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "TIMEOUT" | "ERROR"
      - solve_time_ms: wall-clock solve time
      - objective_value: CP-SAT objective value
      - repaired_rake_paths: { rake_id: [arc_ids] }
      - repaired_demand_fulfillment: { demand_id: [rake_id, arrival_bucket] | null }
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

    if not rakes or not sub_arcs:
        return {
            "status": "FEASIBLE",
            "message": "Empty subproblem (no rakes or arcs)",
            "solve_time_ms": int((time.time() - start_time) * 1000),
            "objective_value": 0.0,
            "repaired_rake_paths": {r: [] for r in rakes},
            "repaired_demand_fulfillment": {}
        }

    print(f"[CP-SAT] Building model: {len(sub_arcs)} arcs, {len(rakes)} rakes, {len(demands)} demands")
    print(f"[CP-SAT] Window: t=[{t_start}..{t_end}], "
          f"Incoming bounds: {len(incoming_bounds)}, Outgoing bounds: {len(outgoing_bounds)}")

    # Identify all (terminal, bucket) nodes in the subnetwork
    nodes = set()
    forward_star: Dict[Tuple[int, int], List[int]] = {}
    reverse_star: Dict[Tuple[int, int], List[int]] = {}

    for arc in sub_arcs:
        u = (arc["from_node"]["terminal_id"], arc["from_node"]["time_bucket"])
        v = (arc["to_node"]["terminal_id"], arc["to_node"]["time_bucket"])
        nodes.add(u)
        nodes.add(v)
        forward_star.setdefault(u, []).append(arc["arc_id"])
        reverse_star.setdefault(v, []).append(arc["arc_id"])

    # ─── 1. Decision Variables ────────────────────────────────────────────
    x = {}
    for arc in sub_arcs:
        aid = arc["arc_id"]
        for rid in rakes:
            x[aid, rid] = model.NewBoolVar(f"x_a{aid}_r{rid}")

    u_vars = {}
    for d in demands:
        did = d["demand_id"]
        u_vars[did] = model.NewBoolVar(f"u_d{did}")

    lateness = {}
    for d in demands:
        did = d["demand_id"]
        max_late = max(0, t_end - d.get("due_time_bucket", t_end))
        lateness[did] = model.NewIntVar(0, max(1, max_late), f"late_d{did}")

    # ─── 2. Constraint 1: Rake Flow Conservation & Boundary Pinning ──────
    in_bound_map = {
        (b["terminal_id"], b["boundary_time"], b["rake_id"])
        for b in incoming_bounds
    }
    out_bound_map = {
        (b["terminal_id"], b["boundary_time"], b["rake_id"])
        for b in outgoing_bounds
    }

    for (term, b_time) in nodes:
        for rid in rakes:
            in_arcs = reverse_star.get((term, b_time), [])
            out_arcs = forward_star.get((term, b_time), [])

            # Filter to arcs that exist in x
            flow_in_terms = [x[aid, rid] for aid in in_arcs if (aid, rid) in x]
            flow_out_terms = [x[aid, rid] for aid in out_arcs if (aid, rid) in x]

            flow_in = sum(flow_in_terms) if flow_in_terms else 0
            flow_out = sum(flow_out_terms) if flow_out_terms else 0

            is_in_source = (term, b_time, rid) in in_bound_map
            is_out_sink = (term, b_time, rid) in out_bound_map

            if is_in_source and is_out_sink:
                model.Add(flow_in == flow_out)
            elif is_in_source:
                model.Add(flow_out - flow_in == 1)
            elif is_out_sink:
                model.Add(flow_in - flow_out == 1)
            else:
                model.Add(flow_in == flow_out)

    # ─── 3. Constraint 2: Terminal Loading/Unloading Capacities ───────────
    residual_terminals = input_data.get("residual_terminal_capacities", {})
    for (term, b_time) in nodes:
        cap_key = f"{term}_{b_time}"
        if cap_key in residual_terminals:
            caps = residual_terminals[cap_key]
            max_load = caps.get("max_loading_rakes", 4)
            max_unload = caps.get("max_unloading_rakes", 4)
        else:
            max_load, max_unload = 4, 4

        dep_loaded_vars = []
        for aid in forward_star.get((term, b_time), []):
            arc = arc_by_id[aid]
            if is_loaded_movement(arc):
                for rid in rakes:
                    if (aid, rid) in x:
                        dep_loaded_vars.append(x[aid, rid])
        if dep_loaded_vars:
            model.Add(sum(dep_loaded_vars) <= max_load)

        arr_loaded_vars = []
        for aid in reverse_star.get((term, b_time), []):
            arc = arc_by_id[aid]
            if is_loaded_movement(arc):
                for rid in rakes:
                    if (aid, rid) in x:
                        arr_loaded_vars.append(x[aid, rid])
        if arr_loaded_vars:
            model.Add(sum(arr_loaded_vars) <= max_unload)

    # ─── 4. Constraint 3: Section Corridor Track Capacities ──────────────
    residual_sections = input_data.get("residual_section_capacities", {})
    for sec_key_str, max_sec_cap in residual_sections.items():
        try:
            parts = sec_key_str.replace("(", "").replace(")", "").split(",")
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
                        if (aid, rid) in x:
                            active_section_vars.append(x[aid, rid])
        if active_section_vars:
            model.Add(sum(active_section_vars) <= max_sec_cap)

    # ─── 5. Constraint 4: Stock-Type Compatibility ───────────────────────
    for arc in sub_arcs:
        aid = arc["arc_id"]
        allowed = arc.get("allowed_stock_types", [])
        if allowed:
            for rid in rakes:
                stype = rake_stock[rid]
                if stype not in allowed:
                    if (aid, rid) in x:
                        model.Add(x[aid, rid] == 0)

    # ─── 6. Demand Fulfillment & Lateness ────────────────────────────────
    for d in demands:
        did = d["demand_id"]
        matching_arcs = [
            arc["arc_id"] for arc in sub_arcs
            if get_arc_demand_id(arc) == did
        ]

        if matching_arcs:
            service_terms = []
            for aid in matching_arcs:
                for rid in rakes:
                    if (aid, rid) in x:
                        service_terms.append(x[aid, rid])
            if service_terms:
                service_expr = sum(service_terms)
                model.Add(service_expr + u_vars[did] * d["quantity_rakes"] >= d["quantity_rakes"])

                for aid in matching_arcs:
                    arr_t = arc_by_id[aid]["to_node"]["time_bucket"]
                    delay = max(0, arr_t - d.get("due_time_bucket", arr_t))
                    if delay > 0:
                        for rid in rakes:
                            if (aid, rid) in x:
                                model.Add(lateness[did] >= delay * x[aid, rid])
            else:
                model.Add(u_vars[did] == 1)
        else:
            model.Add(u_vars[did] == 1)

    # ─── 7. Constraint 5 & 6: Servicing & Maintenance ────────────────────
    maintenance_windows = input_data.get("maintenance_windows", [])
    for mw in maintenance_windows:
        m_rid = mw["rake_id"]
        m_start = mw["start_bucket"]
        m_end = mw["end_bucket"]
        if m_rid in rakes:
            for arc in sub_arcs:
                aid = arc["arc_id"]
                overlaps = not (
                    arc["to_node"]["time_bucket"] <= m_start or
                    arc["from_node"]["time_bucket"] >= m_end
                )
                if overlaps and not is_scheduled_maintenance(arc):
                    if (aid, m_rid) in x:
                        model.Add(x[aid, m_rid] == 0)

    # ─── 8. Objective Function ───────────────────────────────────────────
    obj_terms = []

    w_unserved = int(weights.get("w_unserved", 5000))
    for d in demands:
        pen = int(d.get("penalty_unserved_weight", 5000))
        obj_terms.append(u_vars[d["demand_id"]] * (w_unserved * pen // 1000))

    w_empty = int(float(weights.get("w_empty_km", 2.5)) * 10)
    for arc in sub_arcs:
        aid = arc["arc_id"]
        if is_empty_repositioning(arc):
            dist = int(get_arc_empty_km(arc))
            for rid in rakes:
                if (aid, rid) in x:
                    obj_terms.append(x[aid, rid] * (w_empty * dist // 10))

    w_det = int(float(weights.get("w_detention_hr", 15.0)) * 10)
    for arc in sub_arcs:
        aid = arc["arc_id"]
        if is_stationary_dwell(arc):
            dwell_buckets = get_arc_dwell_buckets(arc)
            for rid in rakes:
                if (aid, rid) in x:
                    obj_terms.append(x[aid, rid] * (w_det * dwell_buckets // 10))

    w_late = int(weights.get("w_lateness", 250))
    for d in demands:
        rate = int(d.get("lateness_penalty_per_bucket", 200))
        obj_terms.append(lateness[d["demand_id"]] * (w_late * rate // 100))

    if obj_terms:
        model.Minimize(sum(obj_terms))

    # ─── 9. Solve ────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(timeout_sec)
    solver.parameters.num_workers = 4

    print(f"[CP-SAT] Starting solve (timeout={timeout_sec}s)...")
    status = solver.Solve(model)
    elapsed_ms = int((time.time() - start_time) * 1000)

    status_map = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
        cp_model.UNKNOWN: "UNKNOWN",
    }
    status_str = status_map.get(status, "UNKNOWN")
    print(f"[CP-SAT] Status: {status_str}, Time: {elapsed_ms}ms")

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        repaired_paths: Dict[int, List[int]] = {r: [] for r in rakes}
        for rid in rakes:
            chosen_arcs = [
                aid for aid in arc_by_id
                if (aid, rid) in x and solver.Value(x[aid, rid]) == 1
            ]
            chosen_arcs.sort(key=lambda a: arc_by_id[a]["from_node"]["time_bucket"])
            repaired_paths[rid] = chosen_arcs

        repaired_demands: Dict[str, Any] = {}
        for d in demands:
            did = d["demand_id"]
            if solver.Value(u_vars[did]) == 0:
                for arc in sub_arcs:
                    if get_arc_demand_id(arc) == did:
                        for rid in rakes:
                            if (arc["arc_id"], rid) in x and solver.Value(x[arc["arc_id"], rid]) == 1:
                                repaired_demands[str(did)] = {
                                    "rake_id": rid,
                                    "arrival_bucket": arc["to_node"]["time_bucket"]
                                }
                                break
                        if str(did) in repaired_demands:
                            break
            else:
                repaired_demands[str(did)] = None

        obj_val = solver.ObjectiveValue()
        print(f"[CP-SAT] Objective: {obj_val}, "
              f"Paths assigned: {sum(1 for p in repaired_paths.values() if p)}")

        return {
            "status": status_str,
            "solve_time_ms": elapsed_ms,
            "objective_value": obj_val,
            "repaired_rake_paths": {str(k): v for k, v in repaired_paths.items()},
            "repaired_demand_fulfillment": repaired_demands,
        }
    else:
        print(f"[CP-SAT] Solver returned: {status_str}")
        return {
            "status": status_str,
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
        # Read from stdin
        data = sys.stdin.read()
        if data.strip():
            input_data = json.loads(data)
            result = solve_repair_problem(input_data)
            print(json.dumps(result))
        else:
            print("PRJ 287 CP-SAT Exact Repair: Ready for JSON input via CLI or stdin.")
