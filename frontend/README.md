# 📊 AUTOMYRIX Execution Dashboard

The **Execution Dashboard** is a premium, real-time interface designed for monitoring, auditing, and controlling automated test sessions within the NIDOWORKZ Inspectra ecosystem.

## ✨ Key Features

- **Setup Chat**: An interactive interface to guide users through the complex environment provisioning process.
- **Live Tracking**: Real-time visualization of packet flows (PB/PD/PC) and service logs.
- **Execution Reports**: High-fidelity data visualization using Recharts to track success rates, latency, and throughput.
- **JSON Data Audit**: Direct access to raw execution data for deep-dive debugging and validation.

## 🛠️ Technology Stack

- **Framework**: React 18+ (Vite)
- **Styling**: Vanilla CSS (Premium Aesthetics)
- **Charts**: Recharts
- **Icons**: Lucide React
- **Networking**: Socket.io-client & Axios

## 📁 Project Structure

- `src/components/`: Modular UI components (Dashboard, SetupPanel, ExecutionReport).
- `src/hooks/`: Custom hooks for socket management and data fetching.
- `src/styles/`: Centralized design system with modern tokens and animations.

## ⚙️ Setup

1.  **Install Deps**: `npm install`
2.  **Configure Env**: 
    ```env
    VITE_API_BASE=http://localhost:4200
    VITE_ORCHESTRATOR_URL=ws://localhost:4200
    ```
3.  **Development**: `npm run dev`

## 🎨 Design Principles

- **Premium Aesthetics**: Uses dark mode with vibrant gradients and glassmorphism.
- **Interactive Micro-animations**: Enhances UX through subtle hover effects and transitions.
- **Responsive Layout**: Fully functional across desktop and tablets.

---
**NIDOWORKZ Proprietary Tool**
