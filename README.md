# Learned Scheduling of Railway Freight Rakes

> **PRJ_287 · CSE7102 Mini Project · B.Tech Computer Science & Engineering**

An AI-driven stochastic railway freight-rake scheduling framework that combines **probabilistic demand forecasting, learned Large-Neighbourhood Search (LNS), exact CP-SAT optimization, and a verified natural-language constraint interface** to improve the utilization of limited railway freight rakes.

## 📌 Overview

Railway freight scheduling involves allocating a limited pool of indivisible and commodity-specific rakes to customer freight demands while considering network capacity, terminal operations, rake availability, servicing requirements, maintenance windows, and uncertain future demand.

A rake is treated as a complete coupled set of freight wagons operated as a single unit. Every hour a rake spends idle or travelling empty represents capacity that cannot be recovered.

The project addresses this problem by integrating **forecasting and scheduling** rather than treating them as independent tasks.

The proposed system follows a strict separation of authority:

> **Language specifies → Verifier validates → Solver decides → Data grounds**

The language model is **never responsible for generating rake assignments or schedules**. The optimization core remains the only component allowed to produce a schedule.

## 🎯 Objectives

- Efficiently allocate a finite pool of railway freight rakes.
- Account for uncertain freight demand and rake release times.
- Reduce unserved freight demand.
- Minimize unnecessary empty rake movement.
- Reduce terminal detention hours.
- Minimize delivery lateness.
- Improve optimization scalability using Large-Neighbourhood Search.
- Learn effective LNS destroy regions using a Graph Neural Network.
- Maintain solution feasibility through exact CP-SAT repair.
- Allow planners to express operational constraints using natural language.
- Verify every generated constraint before it can affect the optimization model.

## 🚨 Problem Statement

### Assigned Problem

> **“Forecasting and scheduling of railway rakes.”**

The problem consists of two interconnected tasks:

### 1. Demand Forecasting

Predict:

- Freight demand
- Origin–destination pairs
- Commodity requirements
- Demand timing
- Rake release times

Because future demand is stochastic, the system does not rely only on a single point forecast.

### 2. Rake Scheduling

Given a finite pool of rakes and uncertain demand, determine:

- Which rake serves which indent
- When the rake moves
- Where empty rakes should be repositioned
- When rakes remain at terminals
- How operational constraints are satisfied

Scheduling decisions are coupled across time, meaning a decision made today affects rake availability in future time periods.

## 🧩 Why the Problem is Difficult

### Indivisible and Typed Assets
A rake cannot be partially allocated, and different wagon types are compatible with different commodities.

### Decisions are Coupled Across Time
Assigning a rake to a demand today determines where and when that rake becomes available for future assignments.

### Demand is Stochastic
Optimizing against a single point forecast can produce a schedule that performs poorly when actual demand differs from the prediction.

## 🏗️ System Architecture

The system is organized into three major layers:

```text
┌───────────────────────────────────────────────────────────┐
│                       SPECIFY                             │
│                                                           │
│ Planner → LLM Constraint Compiler → Schema Validation     │
│                         ↓                                 │
│                Feasibility Verification                  │
│                         ↓                                 │
│                 Verified Constraint Set                  │
└─────────────────────────┬─────────────────────────────────┘
                          ↓
┌───────────────────────────────────────────────────────────┐
│                        SOLVE                              │
│                                                           │
│ Time-Space Network + Current Schedule                     │
│                    ↓                                      │
│          GNN Neighbourhood Selector                       │
│                    ↓                                      │
│              Learned LNS                                  │
│                    ↓                                      │
│            CP-SAT Exact Repair                            │
│                    ↓                                      │
│             Feasible Schedule                             │
└─────────────────────────┬─────────────────────────────────┘
                          ↓
┌───────────────────────────────────────────────────────────┐
│                       GROUND                              │
│                                                           │
│ Probabilistic Forecasting                                │
│ Instance & Scenario Generation                            │
│ Benchmarking & Replay                                    │
└───────────────────────────────────────────────────────────┘
```

### Architecture Diagram

Place the Eraser/system architecture diagram at:

```text
docs/architecture/system-architecture.png
```

Then display it using:

```markdown
![System Architecture](docs/architecture/system-architecture.png)
```

## 🔄 System Workflow

```text
Planner Requirements
        │
        ▼
Natural Language
        │
        ▼
LLM Constraint Compiler
        │
        ▼
Constraint DSL
        │
        ▼
Schema Validation
        │
        ▼
Feasibility Probe
        │
   ┌────┴─────┐
   │          │
 Valid      Invalid
   │          │
   │          ▼
   │    Structured Error
   │          │
   │          └──────► LLM Repair
   │
   ▼
Verified Constraints
        │
        ▼
Railway Network + Demand Scenarios
        │
        ├──────────────► Probabilistic Forecasting
        │
        ▼
Time-Space Network
        │
        ▼
Current Schedule / Incumbent
        │
        ▼
GNN Neighbourhood Selector
        │
        ▼
Learned Destroy Region
        │
        ▼
Large-Neighbourhood Search
        │
        ▼
CP-SAT Exact Repair
        │
        ▼
Feasible Schedule
        │
        ▼
Scenario Comparison / Explanation
        │
        ▼
Planner Interface
```

## 🧠 Core Methodology

### 1. Time-Space Network

The railway system is represented as a **time-expanded network**.

Each node represents:

```text
(Terminal, Time Bucket)
```

Arcs represent:

- Loaded movement
- Empty repositioning
- Dwell

A rake is represented as a **unit of flow**, and a schedule is represented as a collection of paths through this network.

### 2. Probabilistic Demand Forecasting

The forecasting component predicts:

- Demand for each origin–destination–commodity combination
- Rake release times

Instead of providing only a mean prediction, the system uses **calibrated quantiles** so that the scheduler receives a distribution representing uncertainty.

A pretrained time-series foundation model is fine-tuned for the relevant series, while classical seasonal models are retained as baselines.

### 3. Learned Large-Neighbourhood Search

Full exact optimization over the complete time-expanded network can become computationally expensive.

LNS addresses this by:

1. Taking the current schedule.
2. Destroying a portion of the schedule.
3. Re-optimizing that portion exactly.
4. Updating the incumbent solution.
5. Repeating the process.

The project replaces the conventional handcrafted destroy operator with a **Graph Neural Network**.

### 4. GNN Neighbourhood Selector

The GNN receives:

- The time-space graph
- The current schedule

and learns which region of the schedule should be destroyed.

The policy is trained using **policy gradient** based on the improvement achieved by its choices.

The central experimental comparison is:

```text
Handcrafted Destroy Operator
              VS
Learned GNN Destroy Operator
```

with all other components held constant.

### 5. Exact CP-SAT Repair

After the GNN selects a region:

```text
Current Schedule
       ↓
Destroy Selected Region
       ↓
CP-SAT Re-optimization
       ↓
Repaired Feasible Schedule
```

Google OR-Tools CP-SAT performs the exact fragment re-optimization and provides the feasibility guarantee for the generated schedule.

## 📐 Optimization Model

The optimization objective minimizes a weighted combination of:

- **Unserved demand**
- **Empty kilometres**
- **Detention hours**
- **Delivery lateness**

### Constraints

- Rake conservation at every node
- Terminal loading/unloading capacity
- Section capacity
- Stock-type compatibility
- Minimum servicing time
- Scheduled maintenance windows

## 🤖 Natural-Language Constraint Interface

Planners can specify requirements using natural language.

Example:

> "No rakes to the port terminal on Sundays."

Other examples include:

> "Prioritize steel over cement."

> "Cap empty running at fifteen percent."

The system converts the natural-language requirement into a structured **constraint DSL**.

```text
Natural Language
      ↓
LLM Compiler
      ↓
Constraint DSL
      ↓
Schema Validation
      ↓
Feasibility Probe
      ↓
Verified Constraint
```

Invalid constraints are rejected and returned to the compiler with structured errors for repair.

### Important Design Constraint

> **The LLM never generates rake assignments or schedules.**

The LLM only specifies constraints; the optimization engine produces the schedule.

## 🔌 MCP Agent Interface

The system exposes an MCP server providing tools for:

```text
solve
compare_scenarios
explain_assignment
```

These tools allow a planner or agent to:

- Execute scheduling scenarios.
- Compare different scenarios.
- Request explanations for assignments.

Explanations are grounded in optimization information such as **LP dual values and binding constraints**, rather than unsupported generated explanations.

## 🛠️ Technology Stack

### Software

| Component | Technology |
|---|---|
| Instance Generator | Python |
| Forecasting | PyTorch + Time-Series Foundation Model |
| Solver Core | Rust |
| GNN Neighbourhood Selector | PyTorch Geometric |
| Exact Repair | Google OR-Tools CP-SAT |
| Constraint Compiler | LLM API + JSON Schema |
| Backend / Orchestration | NestJS |
| Job Queue | BullMQ |
| Queue / State Management | Redis |
| Persistence | PostgreSQL + Prisma |
| Agent Interface | MCP Server |
| Frontend | React |
| Real-Time Communication | WebSocket |

### Hardware

The project does not require dedicated hardware.

**Hardware Requirement:** Standard development computer/server infrastructure.

## 📊 Data Strategy

Granular railway rake-movement data is not publicly available. Therefore, the project uses:

### Parametric Instance Generator

A generator produces synthetic:

- Railway networks
- Rake pools
- Demand streams

The generated instances are calibrated against published freight-originating tonnage and commodity-mix statistics to make their structure and seasonality realistic.

### Standard Benchmarks

Standard vehicle-scheduling benchmarks are also used so that the optimization approach can be evaluated independently of proprietary railway data.

## 🧪 Evaluation Strategy

The project focuses on **measured algorithmic improvement**, rather than simply demonstrating a working interface.

The methods are compared on identical instances, with an oracle used to estimate achievable improvement.

### Key Evaluation Dimensions

#### 1. Anytime Performance
Measure solution quality against **wall-clock time**.

#### 2. Ablation Study

```text
Learned GNN Selector
        VS
Handcrafted Destroy Operator
```

All other components remain fixed.

#### 3. Forecast Uncertainty

Measure regret against an oracle, comparing decisions made using forecasts against decisions made with hindsight.

#### 4. Failure Analysis

Document instances where the learned operator performs worse than the handcrafted alternative and analyze why.

## 📈 Evaluation Metrics

- Unserved demand
- Empty kilometres
- Detention hours
- Delivery lateness
- Runtime
- Solution quality
- Gap from oracle
- Learned vs. handcrafted LNS performance
- Constraint rejection rate

Negative results and failure cases are treated as valid experimental outcomes.

## 🎯 Expected Outcomes

The completed system is expected to provide:

- Feasible freight-rake schedules.
- Improved utilization of the available rake pool.
- Reduced unserved demand.
- Reduced empty rake movement.
- Reduced detention and delivery delays.
- Probabilistic demand scenarios for scheduling under uncertainty.
- A learned neighbourhood-selection strategy for LNS.
- Exact repair through CP-SAT.
- A verified natural-language interface for specifying constraints.
- Scenario execution, comparison, and assignment explanations.

The project's primary claim is **algorithmic performance on realistic synthetic instances**, rather than validated performance on a specific Indian Railways division.

## 🗓️ Development Roadmap

### Weeks 1–3 — Foundation

- Instance generator
- Time-space graph
- Greedy first-come-first-served baseline
- Metric harness

### Weeks 4–6 — Exact & Forecast

- CP-SAT model on small instances
- Establish optimal solutions
- Forecast service
- Calibrated quantiles
- Seasonal forecasting baseline

### Weeks 7–10 — Scale & Learn

- Handcrafted LNS destroy operator
- GNN neighbourhood selector
- GNN training loop
- Rolling-horizon re-optimization
- Scenario sampling

### Weeks 11–13 — Specify & Demonstrate

- Natural-language constraint compiler
- Constraint verifier
- MCP surface
- Discrete-event replay simulator
- Full benchmark sweep
- Ablation study

## 📁 Repository Structure

```text
learned-railway-rake-scheduling/
│
├── README.md
├── LICENSE
├── .gitignore
├── requirements.txt
│
├── docs/
│   ├── architecture/
│   │   └── system-architecture.png
│   ├── literature-review/
│   ├── project-report/
│   └── presentation/
│
├── data/
│   ├── raw/
│   ├── processed/
│   └── README.md
│
├── forecasting/
│   ├── models/
│   ├── training/
│   ├── inference/
│   └── README.md
│
├── optimization/
│   ├── time_space_network/
│   ├── lns/
│   ├── gnn/
│   ├── cp_sat/
│   └── README.md
│
├── constraint_compiler/
│   ├── llm/
│   ├── schemas/
│   ├── validation/
│   └── README.md
│
├── backend/
│   └── src/
│
├── frontend/
│   └── src/
│
├── mcp-server/
│   └── src/
│
├── experiments/
│   ├── benchmarks/
│   ├── results/
│   └── notebooks/
│
└── tests/
    ├── forecasting/
    ├── optimization/
    └── integration/
```

## 🚧 Project Status

**Status: Under Development**

### Development Checklist

- [ ] Parametric instance generator
- [ ] Time-space network model
- [ ] Greedy baseline
- [ ] CP-SAT optimization model
- [ ] Probabilistic forecasting
- [ ] Handcrafted LNS
- [ ] GNN neighbourhood selector
- [ ] GNN training pipeline
- [ ] Rolling-horizon optimization
- [ ] Natural-language constraint compiler
- [ ] Constraint verification
- [ ] MCP server
- [ ] Backend orchestration
- [ ] Frontend interface
- [ ] Replay simulator
- [ ] Benchmark evaluation
- [ ] Ablation study
- [ ] Final documentation

## ⚠️ Limitations

### Lack of Operational Railway Data
Granular rake movement data is not publicly available. Evaluation therefore relies on calibrated synthetic instances and public benchmarks.

### Exact Solver Scalability
Full exact optimization may not scale to large instances. CP-SAT is therefore primarily used for small-instance reference solutions and fragment repair within LNS.

### Learned Operator Performance
The GNN-based operator may not always outperform the handcrafted operator. Such cases are treated as legitimate experimental findings.

### LLM Constraint Errors
The LLM may produce malformed or infeasible constraints. A two-stage verification mechanism is therefore used to reject and repair invalid outputs.

## 🔐 Design Principles

### 1. Language at the Boundary
LLMs are used only for interpreting planner requirements.

### 2. Learning Inside the Search
Machine learning is used to improve the optimization search process.

### 3. Exact Methods as Ground Truth
CP-SAT provides exact fragment repair and feasibility guarantees.

### 4. Data Grounds Decisions
Forecasts, generated instances, scenarios, and benchmark data ground the scheduling process.

> **Language specifies → Verifier gates → Solver decides → Data grounds.**

## 🌱 Why This Project Matters

### Operational Impact
Better rake utilization can allow the same fixed fleet to serve more freight demand while reducing empty running and turnaround time.

### Environmental Impact
Reducing empty rake movement can reduce fuel consumption and emissions associated with moving freight wagons without cargo.

### Planning Impact
The verified natural-language interface allows planners to modify operational policies without directly modifying optimization code, while ensuring that resulting constraints are checked before affecting a plan.

### SDG Alignment

- **SDG 9 — Industry, Innovation and Infrastructure**
- **SDG 12 — Responsible Consumption and Production**

## 📚 Research Areas

- Railway freight scheduling
- Combinatorial optimization
- Time-expanded network optimization
- Large-Neighbourhood Search
- Reinforcement Learning
- Graph Neural Networks
- Probabilistic forecasting
- Time-series foundation models
- Constraint programming
- Neuro-symbolic systems
- Natural-language constraint specification

## 📖 References

The complete literature review and reference list are maintained in:

```text
docs/literature-review/
```

Key research areas include learned LNS, railway scheduling, probabilistic time-series forecasting, and LLM-based constraint programming.

## 👥 Team

| Name | Role |
|---|---|
| **Suhaib S.Z** | Project Leader |
| **Mohammed Ayaan** | Project Member |
| **Noureen Aslam** | Project Member |

**Programme:** B.Tech Computer Science & Engineering  
**Project:** CSE7102 Mini Project — PRJ_287

## 📄 Project Scope

This project does **not** claim:

- Validation on live Indian Railways operations.
- That an LLM can directly schedule railway rakes.
- That the learned operator will always outperform handcrafted LNS.

Instead, the project evaluates whether:

1. The optimization solver can outperform greedy allocation on realistic synthetic instances.
2. A learned neighbourhood selector can improve upon a handcrafted selector.
3. A natural-language constraint interface can reliably generate verified constraints before they affect a schedule.

## 📜 License

This project is developed for **academic and research purposes**.

An appropriate open-source license will be added once the project team decides how the source code should be distributed.
