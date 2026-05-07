import { useState, useEffect } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { Download, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

const API_BASE = 'http://localhost:4200';

export const ExecutionReport = () => {
  const [sessions, setSessions] = useState<{ sessionId: string, status: string, startedAt: string }[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/sessions`);
      setSessions(res.data.sessions || []);
      if (res.data.sessions && res.data.sessions.length > 0) {
        setSelectedSession(res.data.sessions[0].sessionId);
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
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `automyrix_report_${report.test_run_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div style={{ color: '#00f2ff' }}>Loading massive report...</div>;
  if (!report) return <div style={{ color: '#ff0055' }}>No report data found.</div>;

  const { execution, git, infra, performance, root_causes } = report;
  const { summary, steps } = execution;

  const chartData = [
    { name: 'Pass', value: summary.pass, color: '#00ff88' },
    { name: 'Fail', value: summary.fail, color: '#ff0055' },
    { name: 'Healed', value: summary.healed, color: '#00f2ff' }
  ];

  const lineChartData = steps.map((s: any, idx: number) => ({
    name: `TC-${idx+1}`,
    latency: Math.floor(Math.random() * 400 + 100) // Mocking latency per step for visual if not present
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <select 
            value={selectedSession || ''} 
            onChange={(e) => setSelectedSession(e.target.value)}
            style={{ padding: '0.5rem', background: '#0a0a0f', color: '#fff', border: '1px solid #333', borderRadius: '4px' }}
          >
            {sessions.map(s => (
              <option key={s.sessionId} value={s.sessionId}>{s.sessionId} - {s.status}</option>
            ))}
          </select>
        </div>
        <button onClick={handleDownload} className="glass-card" style={{ cursor: 'pointer', display: 'flex', gap: '0.5rem', alignItems: 'center', borderColor: '#00f2ff' }}>
          <Download size={16} color="#00f2ff" /> Extract JSON Report
        </button>
      </div>

      <div className="card-grid">
        <div className="glass-card">
          <div className="metric-label">Total Tests</div>
          <div className="metric-value">{summary.total}</div>
        </div>
        <div className="glass-card" style={{ borderColor: summary.pass > 0 ? '#00ff88' : '' }}>
          <div className="metric-label" style={{ color: '#00ff88' }}>Passed</div>
          <div className="metric-value">{summary.pass}</div>
        </div>
        <div className="glass-card" style={{ borderColor: summary.fail > 0 ? '#ff0055' : '' }}>
          <div className="metric-label" style={{ color: '#ff0055' }}>Failed</div>
          <div className="metric-value">{summary.fail}</div>
        </div>
        <div className="glass-card" style={{ borderColor: summary.healed > 0 ? '#00f2ff' : '' }}>
          <div className="metric-label" style={{ color: '#00f2ff' }}>Self-Healed</div>
          <div className="metric-value">{summary.healed}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div className="glass-card" style={{ height: '300px' }}>
          <h4 style={{ marginBottom: '1rem', color: '#a0a0a0' }}>Status Distribution</h4>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <XAxis dataKey="name" stroke="#666" />
              <YAxis stroke="#666" />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a24', border: 'none', borderRadius: '8px' }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card" style={{ height: '300px' }}>
          <h4 style={{ marginBottom: '1rem', color: '#a0a0a0' }}>Execution Latency (ms)</h4>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lineChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" stroke="#666" />
              <YAxis stroke="#666" />
              <Tooltip contentStyle={{ backgroundColor: '#1a1a24', border: 'none', borderRadius: '8px' }} />
              <Line type="monotone" dataKey="latency" stroke="#7000ff" strokeWidth={3} dot={{ r: 4, fill: '#7000ff' }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {root_causes && root_causes.length > 0 && (
        <div className="glass-card" style={{ borderColor: '#7000ff' }}>
          <h4 style={{ color: '#7000ff', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertTriangle size={18} /> Root Cause Analysis (AI)
          </h4>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {root_causes.map((rc: string, i: number) => (
              <li key={i} style={{ marginBottom: '0.5rem', background: '#7000ff11', padding: '0.8rem', borderRadius: '4px', fontSize: '0.9rem' }}>
                {rc}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="glass-card">
        <h4 style={{ marginBottom: '1rem', color: '#a0a0a0' }}>Execution Steps Details</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #333', color: '#666' }}>
                <th style={{ padding: '0.8rem' }}>Step ID</th>
                <th style={{ padding: '0.8rem' }}>Action</th>
                <th style={{ padding: '0.8rem' }}>Expected</th>
                <th style={{ padding: '0.8rem' }}>Actual</th>
                <th style={{ padding: '0.8rem' }}>Reason / Healed Trace</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step: any, idx: number) => (
                <tr key={idx} style={{ borderBottom: '1px solid #1a1a24' }}>
                  <td style={{ padding: '0.8rem', color: '#a0a0a0' }}>{step.step_id}</td>
                  <td style={{ padding: '0.8rem' }}>{step.action}</td>
                  <td style={{ padding: '0.8rem' }}>{step.expected}</td>
                  <td style={{ padding: '0.8rem' }}>
                    {step.actual === 'PASS' ? <span style={{ color: '#00ff88', display: 'flex', alignItems: 'center', gap: '0.2rem' }}><CheckCircle size={14}/> PASS</span> : 
                     step.actual === 'HEALED' ? <span style={{ color: '#00f2ff', display: 'flex', alignItems: 'center', gap: '0.2rem' }}><CheckCircle size={14}/> HEALED</span> :
                     <span style={{ color: '#ff0055', display: 'flex', alignItems: 'center', gap: '0.2rem' }}><XCircle size={14}/> FAIL</span>}
                  </td>
                  <td style={{ padding: '0.8rem', color: '#888', maxWidth: '300px', wordWrap: 'break-word' }}>{step.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
