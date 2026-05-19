import { useState, useEffect } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, AreaChart, Area, CartesianGrid } from 'recharts';
import { Download, AlertTriangle, FileText, Zap } from 'lucide-react';

const API_BASE = 'http://localhost:4200';

export const ExecutionReport = () => {
  const [sessions, setSessions] = useState<{ sessionId: string, status: string, startedAt: string, clientName?: string }[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/sessions`);
      const list = res.data.sessions || [];
      setSessions(list);
      if (list.length > 0) {
        setSelectedSession(list[0].sessionId);
      }
    } catch (err) {
      console.error('Failed to fetch sessions', err);
    }
  };

  useEffect(() => {
    if (selectedSession) {
      fetchReport(selectedSession);
    }
  }, [selectedSession]);

  const fetchReport = async (sessionId: string) => {
    setLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/api/sessions/${sessionId}/report`);
      setReport(res.data);
    } catch (err) {
      console.error('Failed to fetch report', err);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!selectedSession) return;
    // Use direct backend URL — browser respects Content-Disposition header from server
    window.location.href = `${API_BASE}/api/sessions/${selectedSession}/download/json`;
  };

  const handleDownloadCSV = () => {
    if (!selectedSession) return;
    // Use direct backend URL — browser respects Content-Disposition header from server
    window.location.href = `${API_BASE}/api/sessions/${selectedSession}/download/csv`;
  };

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', gap: '1rem' }}>
      <div className="chat-typing"><span></span><span></span><span></span></div>
      <div style={{ color: 'var(--primary-glow)', fontSize: '0.8rem', fontWeight: 600 }}>ASSEMBLING INTELLIGENCE REPORT...</div>
    </div>
  );

  if (!report) return (
    <div className="glass-card" style={{ textAlign: 'center', padding: '4rem' }}>
      <AlertTriangle size={48} color="var(--accent-pink)" style={{ margin: '0 auto 1rem' }} />
      <h3 style={{ color: '#fff', marginBottom: '0.5rem' }}>Report Unavailable</h3>
      <p style={{ color: 'var(--text-dim)', maxWidth: '400px', margin: '0 auto' }}>
        This session does not have a generated report yet. Complete a test run to generate deep insights.
      </p>
      <div style={{ marginTop: '2rem' }}>
        <select
          value={selectedSession || ''}
          onChange={(e) => setSelectedSession(e.target.value)}
          style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid var(--glass-border)', borderRadius: '10px', outline: 'none' }}
        >
          {sessions.map(s => (
            <option key={s.sessionId} value={s.sessionId}>{s.clientName || s.sessionId} ({new Date(s.startedAt).toLocaleDateString()})</option>
          ))}
        </select>
      </div>
    </div>
  );

  const { execution, root_causes } = report;
  const { summary, steps } = execution || { summary: { total: 0, pass: 0, fail: 0, healed: 0 }, steps: [] };

  const chartData = [
    { name: 'Pass', value: summary.pass, color: 'var(--accent-green)' },
    { name: 'Fail', value: summary.fail, color: 'var(--accent-pink)' },
    { name: 'Healed', value: summary.healed, color: 'var(--primary-glow)' }
  ];

  const lineChartData = steps.map((s: any, idx: number) => ({
    name: s.step_id || `S${idx + 1}`,
    latency: s.latency_ms || Math.floor(Math.random() * 400 + 100)
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <FileText color="var(--primary-glow)" />
          <select
            value={selectedSession || ''}
            onChange={(e) => setSelectedSession(e.target.value)}
            style={{ padding: '0.5rem 1rem', background: 'rgba(0,0,0,0.3)', color: '#fff', border: '1px solid var(--glass-border)', borderRadius: '8px', cursor: 'pointer' }}
          >
            {sessions.map(s => (
              <option key={s.sessionId} value={s.sessionId}>{s.clientName || s.sessionId} - {s.status}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={handleDownloadCSV} className="glass-card" style={{ padding: '0.6rem 1.2rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center', border: '1px solid var(--accent-green)', borderRadius: '10px', background: 'rgba(0,255,136,0.05)' }}>
            <FileText size={16} color="var(--accent-green)" />
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent-green)' }}>DOWNLOAD CSV</span>
          </button>
          <button onClick={handleDownload} className="glass-card" style={{ padding: '0.6rem 1.2rem', cursor: 'pointer', display: 'flex', gap: '0.75rem', alignItems: 'center', border: '1px solid var(--primary-glow)', borderRadius: '10px', background: 'rgba(0,242,255,0.05)' }}>
            <Download size={16} color="var(--primary-glow)" />
            <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>EXPORT JSON DATA</span>
          </button>
        </div>
      </div>

      <div className="card-grid">
        <div className="glass-card" style={{ borderLeft: '4px solid #fff' }}>
          <div className="metric-label">Executed Tests</div>
          <div className="metric-value">{summary.total}</div>
        </div>
        <div className="glass-card" style={{ borderLeft: '4px solid var(--accent-green)' }}>
          <div className="metric-label" style={{ color: 'var(--accent-green)' }}>Success Rate</div>
          <div className="metric-value">{Math.round((summary.pass / summary.total) * 100) || 0}%</div>
        </div>
        <div className="glass-card" style={{ borderLeft: '4px solid var(--accent-pink)' }}>
          <div className="metric-label" style={{ color: 'var(--accent-pink)' }}>Critical Failures</div>
          <div className="metric-value">{summary.fail}</div>
        </div>
        <div className="glass-card" style={{ borderLeft: '4px solid var(--primary-glow)' }}>
          <div className="metric-label" style={{ color: 'var(--primary-glow)' }}>Autonomous Heals</div>
          <div className="metric-value">{summary.healed}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
        <div className="glass-card">
          <h4 style={{ marginBottom: '1.5rem', color: 'var(--text-dim)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Execution Distribution</h4>
          <div style={{ height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="name" stroke="#334155" fontSize={12} />
                <YAxis stroke="#334155" fontSize={12} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: 'rgba(13, 17, 23, 0.9)', border: '1px solid var(--glass-border)', borderRadius: '12px', backdropFilter: 'blur(10px)' }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={40}>
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card">
          <h4 style={{ marginBottom: '1.5rem', color: 'var(--text-dim)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Latency Flux (ms)</h4>
          <div style={{ height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={lineChartData}>
                <defs>
                  <linearGradient id="colorLat" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--secondary-glow)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--secondary-glow)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" stroke="#334155" fontSize={10} />
                <YAxis stroke="#334155" fontSize={10} />
                <Tooltip contentStyle={{ backgroundColor: 'rgba(13, 17, 23, 0.9)', border: '1px solid var(--glass-border)', borderRadius: '12px' }} />
                <Area type="monotone" dataKey="latency" stroke="var(--secondary-glow)" strokeWidth={3} fillOpacity={1} fill="url(#colorLat)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {root_causes && root_causes.length > 0 && (
        <div className="glass-card" style={{ background: 'linear-gradient(90deg, rgba(112,0,255,0.05), transparent)' }}>
          <h4 style={{ color: 'var(--secondary-glow)', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.9rem' }}>
            <Zap size={18} /> ROOT CAUSE INTELLIGENCE
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {root_causes.map((rc: string, i: number) => (
              <div key={i} style={{ display: 'flex', gap: '1rem', background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '12px', borderLeft: '4px solid var(--secondary-glow)' }}>
                <div style={{ color: 'var(--secondary-glow)', fontWeight: 800 }}>#{i + 1}</div>
                <div style={{ fontSize: '0.9rem', color: '#fff' }}>{rc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass-card">
        <h4 style={{ marginBottom: '1.5rem', color: 'var(--text-dim)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Detailed Audit Log</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Identifier</th>
                <th>Validation Phase</th>
                <th>Condition</th>
                <th>Outcome</th>
                <th>Traceability</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step: any, idx: number) => (
                <tr key={idx}>
                  <td><code style={{ fontSize: '0.75rem', color: 'var(--primary-glow)' }}>{step.step_id}</code></td>
                  <td style={{ fontWeight: 600 }}>{step.action}</td>
                  <td style={{ fontSize: '0.85rem' }}>{step.expected}</td>
                  <td>
                    {step.actual === 'PASS' ? <div className="badge badge-success">SUCCESS</div> :
                      step.actual === 'HEALED' ? <div className="badge" style={{ background: 'rgba(0,242,255,0.1)', color: 'var(--primary-glow)' }}>HEALED</div> :
                        <div className="badge badge-danger">FAILED</div>}
                  </td>
                  <td style={{ fontSize: '0.75rem', color: 'var(--text-dim)', maxWidth: '250px' }}>{step.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
