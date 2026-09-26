#!/usr/bin/env python3
"""
PRJ 287: CP-SAT Repair Bridge Server
=====================================
Lightweight HTTP server that accepts repair subproblem payloads from the
frontend and invokes the OR-Tools CP-SAT solver.

Usage:
    python rust_core/cpsat_bridge_server.py
    
Endpoints:
    POST /repair  — Accepts JSON repair payload, returns CP-SAT solution
    GET  /health  — Health check
"""

import http.server
import json
import sys
import os
import time
import traceback

# Add parent dir so we can import solver_repair
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solver_repair import solve_repair_problem

PORT = 3001


class CpSatBridgeHandler(http.server.BaseHTTPRequestHandler):
    """Handles repair requests from the frontend."""

    def do_OPTIONS(self):
        """CORS preflight."""
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self._cors_headers()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            try:
                from ortools.sat.python import cp_model
                ortools_ok = True
            except ImportError:
                ortools_ok = False
            self.wfile.write(json.dumps({
                "status": "ok",
                "ortools_available": ortools_ok,
                "timestamp": time.time(),
            }).encode())
        else:
            self.send_response(404)
            self._cors_headers()
            self.end_headers()

    def do_POST(self):
        if self.path == '/repair':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                input_data = json.loads(body)
                print(f"[CP-SAT] Received repair request: {len(input_data.get('sub_arcs', []))} arcs, "
                      f"{len(input_data.get('fleet_subset', []))} rakes, "
                      f"{len(input_data.get('active_demands', []))} demands")

                result = solve_repair_problem(input_data)

                print(f"[CP-SAT] Status: {result['status']}, "
                      f"Solve time: {result['solve_time_ms']}ms, "
                      f"Objective: {result.get('objective_value', 'N/A')}")

                self.send_response(200)
                self._cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            except Exception as e:
                print(f"[CP-SAT] ERROR: {e}")
                traceback.print_exc()
                self.send_response(500)
                self._cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ERROR",
                    "message": str(e),
                    "solve_time_ms": 0,
                    "objective_value": 0.0,
                    "repaired_rake_paths": {},
                    "repaired_demand_fulfillment": {},
                }).encode())
        else:
            self.send_response(404)
            self._cors_headers()
            self.end_headers()

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, format, *args):
        """Prefix log messages."""
        sys.stderr.write(f"[CP-SAT Bridge] {args[0]} {args[1]} {args[2]}\n")


def main():
    print(f"[CP-SAT Bridge] Starting on port {PORT}...")
    try:
        from ortools.sat.python import cp_model
        print(f"[CP-SAT Bridge] OR-Tools CP-SAT loaded successfully")
    except ImportError:
        print(f"[CP-SAT Bridge] WARNING: OR-Tools not installed. Install with: pip install ortools")

    server = http.server.HTTPServer(('0.0.0.0', PORT), CpSatBridgeHandler)
    print(f"[CP-SAT Bridge] Listening at http://localhost:{PORT}")
    print(f"[CP-SAT Bridge] POST /repair — Send repair payload")
    print(f"[CP-SAT Bridge] GET  /health — Health check")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[CP-SAT Bridge] Shutting down...")
        server.server_close()


if __name__ == '__main__':
    main()
