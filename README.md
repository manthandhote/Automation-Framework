# 🚀 AUTOMYRIX: Autonomous Orchestration & QA Engine

**AUTOMYRIX** is the flagship orchestration, validation, and infrastructure engine of the **NIDOWORKZ Inspectra** platform. It provides a fully autonomous pipeline for enterprise QA, dynamic machine discovery, and high-fidelity hardware simulation.

---

## 🏗️ System Architecture

The system is architected into three specialized layers to ensure scalability and isolation:

### 1. 🧠 Control Backend (`/backend`)
The central nervous system of Automyrix.
- **Orchestrator**: Manages environment lifecycle, Git operations, and service spawning.
- **TestRunner**: Coordinates AI-driven test execution and data validation.
- **AI Analyst**: Integrates with local LLMs (Ollama/Llama3) for deep codebase and database introspection.
- **Real-time Engine**: Powered by Socket.io for live event streaming and control.

### 2. 📊 Execution Dashboard (`/frontend`)
A premium, data-driven React interface for monitoring and auditing.
- **Interactive Setup**: Guided chat interface for environment provisioning.
- **Live Monitoring**: Real-time visualization of packet flows and service health.
- **Advanced Reporting**: High-fidelity charts (Recharts) and JSON data extraction for comprehensive test auditing.

### 3. 🤖 Remote Infra Node (`/infra-node`)
A distributed agent deployed on edge VM instances.
- **Hardware Simulation**: Executes high-fidelity TCP, Serial, and Modbus packet injections locally.
- **Process Management**: Monitors and manages microservice lifecycles on the target environment.
- **Auto-Discovery**: Reports VM health and infrastructure status back to the Control Backend.

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js**: v18+ 
- **MongoDB**: Instances for metadata (`inspectra_meta`) and isolated test databases.
- **Ollama**: Local instance running `llama3` for AI features.
- **Docker**: Optional, for containerized service isolation.

### 1. Setup Backend
```bash
cd backend
npm install
# Configure .env (see template below)
npm run dev
```

### 2. Setup Frontend
```bash
cd frontend
npm install
# Configure .env
npm run dev
```

### 3. Setup Infra Node
```bash
cd infra-node
npm install
# Configure .env
npm run dev
```

---

## ⚙️ Environment Configuration

### Backend (`backend/.env`)
| Variable | Description |
|----------|-------------|
| `PORT` | API Port (Default: 4200) |
| `INSPECTRA_DB_URI` | MongoDB URI for metadata |
| `OLLAMA_ENDPOINT` | URL for local AI model |
| `GIT_PAT` | Personal Access Token for repo orchestration |

### Frontend (`frontend/.env`)
| Variable | Description |
|----------|-------------|
| `VITE_API_BASE` | HTTP URL of Backend |
| `VITE_ORCHESTRATOR_URL` | WebSocket URL of Backend |

### Infra Node (`infra-node/.env`)
| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_URL` | WebSocket address of the Backend |
| `LOG_LEVEL` | Pino logging level (info/debug) |

## 📁 Project Structure

```text
AUTOMYRIX/
├── backend/            # Control Backend (Node.js/TypeScript)
│   ├── src/
│   │   ├── orchestrator.ts  # Lifecycle management
│   │   ├── test-runner.ts   # Execution logic
│   │   └── index.ts         # API & Socket Server
│   └── .env                 # Backend configuration
├── frontend/           # Execution Dashboard (React/Vite)
│   ├── src/
│   │   ├── components/      # UI components (ExecutionReport, etc.)
│   │   └── App.tsx          # Main entry & Socket management
│   └── .env                 # Frontend configuration
└── infra-node/         # Remote Infrastructure Agent
    ├── src/
    │   ├── simulator.ts     # TCP/Serial/Modbus logic
    │   └── index.ts         # Agent entry & Socket Client
    └── .env                 # Agent configuration
```

---

## 🔄 Execution Flow

1.  **Provisioning**: Orchestrator clones target repos and restores DB backups.
2.  **Discovery**: `DbAnalyzer` extracts machine configs and `CodeAnalyzer` maps the tech stack.
3.  **AI Generation**: `LlamaAnalyst` creates specific test cases based on the discovered architecture.
4.  **Remote Simulation**: Backend sends `infra:simulate-cycle` to the `infra-node`.
5.  **Packet Injection**: `infra-node` executes hardware-level packet injection locally.
6.  **Validation**: `BackendValidator` verifies data propagation across MongoDB layers.
7.  **Audit**: `ExecutionReport` visualizes the entire journey with real-time charts.

---

## 🛡️ NIDOWORKZ Proprietary
**AUTOMYRIX** is a proprietary tool developed for the NIDOWORKZ Inspectra ecosystem.
