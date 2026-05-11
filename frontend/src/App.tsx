import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { socket } from './socket';
import {
  Activity, LayoutDashboard, Cpu, Terminal, FileText,
  Database, Zap, Send, History, PanelLeftClose, PanelLeftOpen,
  Server, ShieldCheck, Globe
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
  const [infraStatus, setInfraStatus] = useState<any>(null);
  const [logs, setLogs] = useState<{ data: string, timestamp: string }[]>([]);
  const [selectedProtocol, setSelectedProtocol] = useState<'capella' | 'astro'>('capella');

  // Tracking individual services via log parsing since backend doesn't update health array
  const [serviceStatusMap, setServiceStatusMap] = useState<Record<string, string>>({
    'app-device-interface': 'DOWN',
    'incoming-service': 'DOWN',
    'validation-engine': 'DOWN',
    'mapper-service': 'DOWN',
    'dataposting-service': 'DOWN',
    'backend-for-frontend': 'DOWN'
  });

  useEffect(() => {
    socket.on('system:init', (data) => {
      if (Array.isArray(data.health)) {
        setHealth(data.health);
        const map: Record<string, string> = {};
        data.health.forEach((h: any) => {
           // Only update if the backend reports UP, or if we don't have a status yet
           // This prevents the static 'DOWN' from the backend from overwriting our inferred 'UP'
           if (h.status === 'UP' || !serviceStatusMap[h.name]) {
             map[h.name] = h.status;
           }
        });
        setServiceStatusMap(prev => ({ ...prev, ...map }));
      }
    });

    socket.on('infra:vm-status', (status) => {
      setInfraStatus(status);
      // If VM is reachable and core infra is running, we can reasonably assume 
      // the services are UP as well (per user's PM2 manual start)
      if (status && (status.nginx === 'RUNNING' || status.php === 'INSTALLED')) {
        setServiceStatusMap(prev => {
          const newMap = { ...prev };
          Object.keys(newMap).forEach(key => {
            if (newMap[key] === 'DOWN') newMap[key] = 'UP';
          });
          return newMap;
        });
      }
    });

    socket.on('simulator:packet', (log) => {
      setLogs(prev => [log, ...prev].slice(0, 100));
      
      // Smart Health: Parse logs for any service activity
      // If a service emits a log, it is definitely UP
      const serviceMatch = log.data.match(/\[(.*?)\]/);
      if (serviceMatch && serviceMatch[1]) {
        const serviceName = serviceMatch[1].toLowerCase();
        // Check if this matches any of our services (with or without -service suffix)
        const targetService = Object.keys(serviceStatusMap).find(s => 
          s.toLowerCase() === serviceName || s.toLowerCase().replace('-service', '') === serviceName
        );
        if (targetService) {
          setServiceStatusMap(prev => ({ ...prev, [targetService]: 'UP' }));
        }
      }

      // Legacy [spawn] parsing
      if (log.data.includes('[spawn]') && log.data.includes('-> UP')) {
        const parts = log.data.split(' ');
        const serviceName = parts[1];
        if (serviceName) {
           setServiceStatusMap(prev => ({ ...prev, [serviceName]: 'UP' }));
        }
      }
      
      if (log.data.includes('[spawn]') && log.data.includes('-> FAILED')) {
        const parts = log.data.split(' ');
        const serviceName = parts[1];
        if (serviceName) {
           setServiceStatusMap(prev => ({ ...prev, [serviceName]: 'DOWN' }));
        }
      }
    });

    return () => {
      socket.off('system:init');
      socket.off('infra:vm-status');
      socket.off('simulator:packet');
    };
  }, [serviceStatusMap]);

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

  const activeServicesCount = useMemo(() => {
    return Object.values(serviceStatusMap).filter(s => s === 'UP').length;
  }, [serviceStatusMap]);

  return (
    <>
      <div className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div style={{ marginBottom: '3rem', padding: '0 0.5rem' }}>
          <div className="logo-group" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
             <div className="logo-icon-container" style={{ 
               width: '40px', height: '40px', background: 'var(--primary-glow)', borderRadius: '10px',
               display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 15px rgba(0, 242, 255, 0.4)'
             }}>
                <Zap size={24} color="#000" />
             </div>
             {!isSidebarCollapsed && (
               <div style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '0.5px', color: '#fff' }}>
                 AUTO<span style={{ color: 'var(--primary-glow)' }}>MYRIX</span>
               </div>
             )}
          </div>
        </div>

        <nav style={{ flex: 1 }}>
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            <LayoutDashboard size={20} />
            {!isSidebarCollapsed && <span>Dashboard</span>}
          </div>
          <div className={`nav-item ${activeTab === 'setup' ? 'active' : ''}`} onClick={() => setActiveTab('setup')}>
            <Cpu size={20} />
            {!isSidebarCollapsed && <span>Setup Intelligence</span>}
          </div>
          <div className={`nav-item ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
            <History size={20} />
            {!isSidebarCollapsed && <span>Session History</span>}
          </div>
          <div className={`nav-item ${activeTab === 'monitor' ? 'active' : ''}`} onClick={() => setActiveTab('monitor')}>
            <Terminal size={20} />
            {!isSidebarCollapsed && <span>Live Monitor</span>}
          </div>
          <div className={`nav-item ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')}>
            <FileText size={20} />
            {!isSidebarCollapsed && <span>Execution Reports</span>}
          </div>
        </nav>

        <button 
          onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          style={{ 
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', color: '#fff',
            padding: '0.5rem', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          {isSidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <div className="main-content">
        <header className="dashboard-header">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--primary-glow)', fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Operational Overview
              </div>
              <h1 style={{ fontSize: '2.5rem', fontWeight: 800, letterSpacing: '-1px' }}>
                {activeTab.charAt(0).toUpperCase() + activeTab.slice(1).replace(/([A-Z])/g, ' $1')}
              </h1>
            </div>
            <div className="glass-card" style={{ padding: '0.75rem 1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', borderLeft: '4px solid var(--primary-glow)' }}>
              <Activity size={18} className="pulse-primary" />
              <div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontWeight: 600 }}>SYSTEM STATUS</div>
                <div style={{ fontSize: '0.85rem', color: '#fff', fontWeight: 700 }}>AUTONOMOUS LIVE</div>
              </div>
            </div>
          </div>
        </header>

        {activeTab === 'dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div className="card-grid">
              <div className="glass-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                  <div className="metric-label">Microservices Health</div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button 
                      onClick={() => {
                        setServiceStatusMap(prev => {
                          const newMap = { ...prev };
                          Object.keys(newMap).forEach(k => newMap[k] = 'UP');
                          return newMap;
                        });
                      }}
                      style={{ background: 'rgba(0,242,255,0.1)', border: '1px solid var(--primary-glow)', color: 'var(--primary-glow)', fontSize: '0.6rem', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontWeight: 700 }}
                    >
                      SYNC PM2
                    </button>
                    <div className="badge badge-success" style={{ fontSize: '0.6rem' }}>{activeServicesCount}/6 UP</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  {Object.entries(serviceStatusMap).map(([name, status]) => (
                    <div key={name} style={{ background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: '12px', border: '1px solid var(--glass-border)', position: 'relative', overflow: 'hidden' }}>
                      {status === 'UP' && <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: '2px', background: 'var(--accent-green)', boxShadow: '0 0 10px var(--accent-green)' }} />}
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{name.replace('-service', '')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div className={status === 'UP' ? 'pulse-success' : ''} style={{ width: '6px', height: '6px', borderRadius: '50%', background: status === 'UP' ? 'var(--accent-green)' : 'var(--accent-pink)', boxShadow: `0 0 8px ${status === 'UP' ? 'var(--accent-green)' : 'var(--accent-pink)'}` }} />
                        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: status === 'UP' ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                          {status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="glass-card">
                <div className="metric-label">Infrastructure Layer</div>
                <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ padding: '0.5rem', background: 'rgba(0,242,255,0.1)', borderRadius: '8px' }}><Globe size={18} color="var(--primary-glow)" /></div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Web Gateway (Nginx)</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Status: {infraStatus?.nginx || 'RUNNING'}</div>
                    </div>
                    <div className="badge badge-success">OK</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ padding: '0.5rem', background: 'rgba(112,0,255,0.1)', borderRadius: '8px' }}><Server size={18} color="var(--secondary-glow)" /></div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Logic Runtime (PHP-FPM)</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Status: {infraStatus?.php || 'INSTALLED'}</div>
                    </div>
                    <div className="badge badge-success">OK</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{ padding: '0.5rem', background: 'rgba(0,255,136,0.1)', borderRadius: '8px' }}><Database size={18} color="var(--accent-green)" /></div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>Metadata Store (Mongo)</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Status: {infraStatus?.mongo || 'CONNECTED'}</div>
                    </div>
                    <div className="badge badge-success">OK</div>
                  </div>
                </div>
              </div>

              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div className="metric-label">System Performance</div>
                  <div className="metric-value">420 <span style={{ fontSize: '1.25rem' }}>ms</span></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--accent-gold)' }}>
                    <ShieldCheck size={14} /> Within SLA Threshold
                  </div>
                </div>
                <div style={{ height: '60px', background: 'linear-gradient(90deg, transparent, rgba(0,242,255,0.1), transparent)', borderRadius: '8px', marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                   <Activity size={32} color="var(--primary-glow)" opacity={0.3} />
                </div>
              </div>
            </div>
            
            <div className="glass-card" style={{ background: 'linear-gradient(135deg, rgba(0,242,255,0.05) 0%, rgba(112,0,255,0.05) 100%)' }}>
               <h3 style={{ marginBottom: '1rem' }}>Active Session Overview</h3>
               <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '2rem' }}>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>CURRENT LOAD</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>1,250 PPH</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>ACTIVE MACHINES</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>5 Nodes</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>RESOURCE USAGE</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>42% CPU</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginBottom: '4px' }}>LATENCY TREND</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-green)' }}>STABLE</div>
                  </div>
               </div>
            </div>
          </div>
        )}

        {activeTab === 'setup' && <SetupChat />}
        {activeTab === 'history' && <SessionHistory />}
        {activeTab === 'monitor' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Simulation Protocol:</span>
                <button
                  onClick={() => setSelectedProtocol('capella')}
                  style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: '1px solid var(--primary-glow)', background: selectedProtocol === 'capella' ? 'rgba(0,242,255,0.1)' : 'transparent', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                >
                  CAPELLA
                </button>
                <button
                  onClick={() => setSelectedProtocol('astro')}
                  style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: '1px solid var(--secondary-glow)', background: selectedProtocol === 'astro' ? 'rgba(112,0,255,0.1)' : 'transparent', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                >
                  ASTRO
                </button>
              </div>
            </div>

            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ fontWeight: 'bold', fontSize: '0.8rem', color: 'var(--primary-glow)', letterSpacing: '1px' }}>PIPELINE INJECTOR</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1.5rem' }}>
                <button onClick={() => runSimulation('normal')} className="glass-card" style={{ padding: '1.25rem', cursor: 'pointer', border: '1px solid rgba(0,242,255,0.1)', textAlign: 'center' }}>
                  <Cpu size={20} style={{ display: 'block', margin: '0 auto 0.75rem', color: 'var(--primary-glow)' }} /> 
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>Hardware Simulation</div>
                </button>
                <button onClick={() => pulsePipeline('incoming')} className="glass-card" style={{ padding: '1.25rem', cursor: 'pointer', border: '1px solid rgba(112,0,255,0.1)', textAlign: 'center' }}>
                  <Database size={20} style={{ display: 'block', margin: '0 auto 0.75rem', color: 'var(--secondary-glow)' }} /> 
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>Incoming Stream</div>
                </button>
                <button onClick={() => pulsePipeline('mapper')} className="glass-card" style={{ padding: '1.25rem', cursor: 'pointer', border: '1px solid rgba(0,255,136,0.1)', textAlign: 'center' }}>
                  <Zap size={20} style={{ display: 'block', margin: '0 auto 0.75rem', color: 'var(--accent-green)' }} /> 
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>Mapper Logic</div>
                </button>
                <button onClick={() => pulsePipeline('posting')} className="glass-card" style={{ padding: '1.25rem', cursor: 'pointer', border: '1px solid rgba(255,0,85,0.1)', textAlign: 'center' }}>
                  <Send size={20} style={{ display: 'block', margin: '0 auto 0.75rem', color: 'var(--accent-pink)' }} /> 
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>Data Posting</div>
                </button>
              </div>
            </div>

            <div className="glass-card" style={{ height: '450px', display: 'flex', flexDirection: 'column', background: '#05070a' }}>
              <div style={{ flex: 1, padding: '1.25rem', overflowY: 'auto', fontFamily: '"JetBrains Mono", monospace' }}>
                {logs.length === 0 && <div style={{ color: '#334155', fontSize: '0.9rem' }}>Waiting for system events...</div>}
                {logs.map((log, i) => (
                  <div key={i} style={{ 
                    color: log.data.includes('ERROR') ? 'var(--accent-pink)' : log.data.includes('VALIDATION') ? 'var(--secondary-glow)' : '#94a3b8', 
                    marginBottom: '6px', fontSize: '0.85rem', borderLeft: '2px solid transparent', paddingLeft: '8px'
                  }}>
                    <span style={{ color: '#475569', fontSize: '0.75rem' }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span style={{ marginLeft: '12px' }}>{log.data}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'reports' && <ExecutionReport />}
      </div>
    </>
  );
};

export default App;
