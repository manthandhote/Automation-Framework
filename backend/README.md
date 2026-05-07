# 🧠 AUTOMYRIX Control Backend

The **Control Backend** is the core orchestration and intelligence layer of the Automyrix ecosystem. It manages the lifecycle of test environments, performs AI-driven analysis, and coordinates remote execution.

## 🚀 Core Responsibilities

- **Orchestration**: Dynamically clones repositories, builds dependencies, and restores database backups for isolated test runs.
- **AI Analysis**: Integrates with local Llama models via Ollama to analyze codebase patterns and database schemas.
- **Automated QA**: Generates high-fidelity test cases based on discovered machine configurations and code logic.
- **Real-time Control**: Manages a bidirectional WebSocket bridge between the Dashboard and remote Infra Nodes.

## 🛠️ Technology Stack

- **Runtime**: Node.js with TypeScript
- **Server**: Express.js
- **Real-time**: Socket.io
- **Database**: MongoDB (via `shared-db` and native driver)
- **AI**: Ollama (Llama3)

## 📁 Key Modules

- `src/orchestrator.ts`: The primary controller for session provisioning and service management.
- `src/test-runner.ts`: Orchestrates the 3-phase execution (Simulation → Validation → UI Check).
- `src/db-analyzer.ts`: Performs dynamic machine discovery from restored MongoDB archives.
- `src/llama-analyst.ts`: Handles communication with the AI engine for scenario generation.

## ⚙️ Setup

1.  **Install Deps**: `npm install`
2.  **Configure Env**: Create `.env` based on the root documentation.
3.  **Development**: `npm run dev`

## 📡 API Endpoints

- `POST /api/coordinate`: Initialize a new enterprise test run.
- `GET /api/session/:id`: Fetch real-time status of a running session.
- `GET /api/health`: Monitor backend system health.

---
**NIDOWORKZ Proprietary Tool**
