import { useState, useEffect } from 'react';
import axios from 'axios';
import { socket } from './socket';
import {
  Activity, LayoutDashboard, Cpu, Terminal, FileText,
  Database, Zap, Send, History, PanelLeftClose, PanelLeftOpen
} from 'lucide-react';
import { SetupChat } from './components/SetupChat';
import { SessionHistory } from './components/SessionHistory';
import { ExecutionReport } from './components/ExecutionReport';
import './index.css';

const API_BASE = 'http://localhost:4200';

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [health, setHealth] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);
  const [logs, setLogs] = useState<{ data: string, timestamp: string }[]>([]);
  const [selectedProtocol, setSelectedProtocol] = useState<'capella' | 'astro'>('capella');

  useEffect(() => {
    socket.on('system:init', (data) => setHealth(data.health));
    socket.on('simulator:packet', (log) => setLogs(prev => [log, ...prev].slice(0, 50)));

    return () => {
      socket.off('system:init');
      socket.off('simulator:packet');
    };
  }, []);

  const runSimulation = async (type: string) => {
    try {
      await axios.post(`${API_BASE}/api/simulate`, {
        scenario: { name: type, packets: [{ type: 'barcode', value: 'AUTO_SIM' }], expected_result: 'PASS' },
        protocol: selectedProtocol
      });
    } catch (err) { console.error('Simulation failed', err); }
  };

  const pulsePipeline = async (stage: string) => {
    try {
      await axios.post(`${API_BASE}/api/pipeline/pulse`, { stage });
    } catch (err) { console.error('Pipeline pulse failed', err); }
  };

  const fetchReport = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/report`);
      setReport(res.data);
    } catch (err) { console.error('Report fetch failed', err); }
  };

  useEffect(() => {
    if (activeTab === 'reports') fetchReport();
  }, [activeTab]);

  return (
    <>
      <div className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          marginBottom: '2rem',
          padding: '0 0.5rem'
        }}>
          {/* Logo & Toggle Overlay Container */}
          <div className="sidebar-header-wrapper" style={{
            position: 'relative',
            width: '100%',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: isSidebarCollapsed ? 'center' : 'space-between',
          }}>
            <div className="logo-group" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              transition: 'all 0.3s ease'
            }}>
              <div className="logo-icon-container" style={{ position: 'relative', width: '32px', height: '32px' }}>
                <img
                  src="/Automyrix-logo.png"
                  alt="Logo"
                  className="sidebar-logo-img"
                  style={{
                    height: '32px',
                    width: '32px',
                    objectFit: 'contain',
                    transition: 'opacity 0.2s ease'
                  }}
                />
                {/* Toggle button overlaying the logo (visible on hover in CSS) */}
                <button
                  onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                  className="sidebar-toggle-btn"
                  title={isSidebarCollapsed ? "Expand" : "Collapse"}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    background: 'rgba(13, 15, 20, 0.8)',
                    border: 'none',
                    color: 'var(--primary-glow)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '8px',
                    opacity: 0,
                    transition: 'opacity 0.2s ease',
                    zIndex: 2
                  }}
                >
                  {isSidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
                </button>
              </div>
              {!isSidebarCollapsed && (
                <div className="logo" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, letterSpacing: '0.5px' }}>Automyrix</div>
              )}
            </div>
          </div>
        </div>

        <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')} title="Dashboard">
          <LayoutDashboard size={20} style={{ marginRight: isSidebarCollapsed ? '0' : '12px' }} />
          {!isSidebarCollapsed && <span>Dashboard</span>}
        </div>
        <div className={`nav-item ${activeTab === 'setup' ? 'active' : ''}`} onClick={() => setActiveTab('setup')} title="Setup Intelligence">
          <Cpu size={20} style={{ marginRight: isSidebarCollapsed ? '0' : '12px' }} />
          {!isSidebarCollapsed && <span>Setup Intelligence</span>}
        </div>
        <div className={`nav-item ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')} title="History">
          <History size={20} style={{ marginRight: isSidebarCollapsed ? '0' : '12px' }} />
          {!isSidebarCollapsed && <span>History</span>}
        </div>
        <div className={`nav-item ${activeTab === 'monitor' ? 'active' : ''}`} onClick={() => setActiveTab('monitor')} title="Live Monitor">
          <Terminal size={20} style={{ marginRight: isSidebarCollapsed ? '0' : '12px' }} />
          {!isSidebarCollapsed && <span>Live Monitor</span>}
        </div>
        <div className={`nav-item ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')} title="Execution Reports">
          <FileText size={20} style={{ marginRight: isSidebarCollapsed ? '0' : '12px' }} />
          {!isSidebarCollapsed && <span>Execution Reports</span>}
        </div>
      </div>

      <div className="main-content">
        <header className="dashboard-header">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>
                {activeTab.charAt(0).toUpperCase() + activeTab.slice(1).replace(/([A-Z])/g, ' $1')}
              </h1>
              <p style={{ color: '#a0a0a0' }}>End-to-End Autonomous QA & Simulation Platform</p>
            </div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <div className="glass-card" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={16} className="pulse-primary" />
                <span style={{ fontSize: '0.8rem', color: '#00f2ff' }}>SYSTEM LIVE</span>
              </div>
            </div>
          </div>
        </header>

        {activeTab === 'dashboard' && (
          <div className="card-grid">
            <div className="glass-card">
              <div className="metric-label">Service Health</div>
              <div style={{ marginTop: '1rem' }}>
                {health.map(h => (
                  <div key={h.name} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.9rem' }}>{h.name}</span>
                    <span style={{ fontSize: '0.8rem', color: h.status === 'UP' ? '#00ff88' : '#ff0055' }}>
                      {h.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card">
              <div className="metric-label">Total Load</div>
              <div className="metric-value">1,250 <span style={{ fontSize: '1rem' }}>PPH</span></div>
              <div style={{ fontSize: '0.8rem', color: '#a0a0a0' }}>Based on 5 active machines</div>
            </div>
            <div className="glass-card">
              <div className="metric-label">AVG Latency</div>
              <div className="metric-value">420 <span style={{ fontSize: '1rem' }}>ms</span></div>
              <div style={{ fontSize: '0.8rem', color: '#ffcc00' }}>Within SLA (500ms)</div>
            </div>
          </div>
        )}

        {activeTab === 'setup' && (
          <SetupChat />
        )}

        {activeTab === 'history' && (
          <SessionHistory />
        )}

        {activeTab === 'monitor' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: '#a0a0a0' }}>Simulation Protocol:</span>
                <button
                  onClick={() => setSelectedProtocol('capella')}
                  style={{ padding: '0.4rem 1rem', borderRadius: '4px', border: '1px solid #00f2ff', background: selectedProtocol === 'capella' ? '#00f2ff22' : 'transparent', color: '#fff', cursor: 'pointer' }}
                >
                  CAPELLA
                </button>
                <button
                  onClick={() => setSelectedProtocol('astro')}
                  style={{ padding: '0.4rem 1rem', borderRadius: '4px', border: '1px solid #7000ff', background: selectedProtocol === 'astro' ? '#7000ff22' : 'transparent', color: '#fff', cursor: 'pointer' }}
                >
                  ASTRO
                </button>
              </div>
              <div style={{ color: '#a0a0a0', fontSize: '0.8rem' }}>
                Cycle: Barcode (PB) → Dim/Weight (PD/PW) → Confirmation (PC)
              </div>
            </div>

            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ fontWeight: 'bold', fontSize: '0.9rem', color: '#00f2ff' }}>PIPELINE INJECTOR</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
                <button onClick={() => runSimulation('normal')} className="glass-card" style={{ padding: '0.8rem', cursor: 'pointer', border: '1px solid #00f2ff44', fontSize: '0.8rem' }}>
                  <Cpu size={14} style={{ display: 'block', margin: '0 auto 0.5rem', color: '#00f2ff' }} /> Hardware (Serial)
                </button>
                <button onClick={() => pulsePipeline('incoming')} className="glass-card" style={{ padding: '0.8rem', cursor: 'pointer', border: '1px solid #7000ff44', fontSize: '0.8rem' }}>
                  <Database size={14} style={{ display: 'block', margin: '0 auto 0.5rem', color: '#7000ff' }} /> Incoming (JSON)
                </button>
                <button onClick={() => pulsePipeline('mapper')} className="glass-card" style={{ padding: '0.8rem', cursor: 'pointer', border: '1px solid #00ff8844', fontSize: '0.8rem' }}>
                  <Zap size={14} style={{ display: 'block', margin: '0 auto 0.5rem', color: '#00ff88' }} /> Mapper (Items)
                </button>
                <button onClick={() => pulsePipeline('posting')} className="glass-card" style={{ padding: '0.8rem', cursor: 'pointer', border: '1px solid #ff005544', fontSize: '0.8rem' }}>
                  <Send size={14} style={{ display: 'block', margin: '0 auto 0.5rem', color: '#ff0055' }} /> Posting (Ready)
                </button>
              </div>
            </div>

            <div className="glass-card" style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: 1, background: '#000', padding: '1rem', borderRadius: '8px', overflowY: 'auto', fontFamily: 'monospace' }}>
                {logs.length === 0 && <div style={{ color: '#444' }}>Waiting for machine packets...</div>}
                {logs.map((log, i) => (
                  <div key={i} style={{ color: log.data.includes('VALIDATION') ? '#7000ff' : '#00ff88', marginBottom: '4px', fontSize: '0.9rem' }}>
                    <span style={{ color: '#666' }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span> {log.data}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'reports' && (
          <ExecutionReport />
        )}
      </div>
    </>
  );
};

export default App;
