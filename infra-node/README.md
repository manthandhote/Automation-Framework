# 🤖 AUTOMYRIX Remote Infra Node

The **Remote Infra Node** is a distributed agent deployed on edge VM instances. It acts as the local "hands" for the Control Backend, performing physical-layer simulations and managing service lifecycles.

## 🚀 Key Capabilities

- **High-Fidelity Simulation**: Locally executes TCP, Serial, and Modbus packet injections for machine simulation.
- **Service Management**: Spawns and monitors target microservices (Incoming, Mapper, etc.) on the remote VM.
- **Infrastructure Provisioning**: Automatically verifies and installs system dependencies like Nginx and PHP.
- **Telemetry**: Streams real-time service logs and hardware packet logs back to the central Orchestrator.

## 🛠️ Technology Stack

- **Runtime**: Node.js
- **Communication**: Socket.io-client (Bidirectional with Backend)
- **Logging**: Pino (High-performance structured logging)
- **Hardware Libs**: `serialport`, `modbus-serial`

## 📁 Key Modules

- `src/index.ts`: Agent entry point and WebSocket event handlers.
- `src/simulator.ts`: The core simulation engine for protocol-level packet injection.
- `src/installer.ts`: Automated dependency installer for Nginx and PHP.
- `src/process-manager.ts`: Manages and monitors local OS processes.

## ⚙️ Setup

1.  **Install Deps**: `npm install`
2.  **Configure Env**:
    ```env
    ORCHESTRATOR_URL=ws://your-backend-ip:4200
    LOG_LEVEL=info
    ```
3.  **Development**: `npm run dev`

## 📡 Event Handlers

- `infra:simulate-cycle`: Triggers a full hardware simulation cycle.
- `infra:start-service`: Spawns a managed microservice.
- `infra:stop-service`: Gracefully terminates a managed service.

---
**NIDOWORKZ Proprietary Tool**
