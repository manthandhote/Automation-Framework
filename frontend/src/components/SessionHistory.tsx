import { useState, useEffect } from 'react';
import axios from 'axios';
import { Clock, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp, FlaskConical, BarChart3, RefreshCw } from 'lucide-react';

const API_BASE = 'http://localhost:4200';

interface Session {
  sessionId: string;
  clientName: string;
  machineCount: number;
  machineDescriptions: string;
  beRepo: string;
  beBranch: string;
  feRepo: string;
  feBranch: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt?: string;
  restoredDbName?: string;
}

interface TestCase {
  testId: string;
  service: string;
  scenario: string;
  description: string;
  expectedStatus: 'PASS' | 'FAIL';
  barcode?: string;
  machineName?: string;
  generatedBy: 'llm' | 'heuristic';
}

interface TestResult {
  testId: string;
  barcode: string;
  service: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  reason?: string;
  executedAt: string;
}

interface Analysis {
  codeInsights: string;
  dbInsights: string;
  scalingPlan: any[];
  recommendations: string[];
  failureAnalysis?: string[];
}

export function SessionHistory() {
  const [sessions, setSessions]     = useState<Session[]>([]);
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [testCases, setTestCases]   = useState<Record<string, TestCase[]>>({});
  const [results, setResults]       = useState<Record<string, TestResult[]>>({});
  const [analysis, setAnalysis]     = useState<Record<string, Analysis>>({});
  const [activeDetail, setActiveDetail] = useState<Record<string, 'cases' | 'results' | 'analysis'>>({});

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000); // poll for running sessions
    return () => clearInterval(interval);
  }, []);

  const handleRerun = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!confirm('Re-run this session? Existing results will be updated.')) return;
    try {
      await axios.post(`${API_BASE}/api/sessions/${sessionId}/rerun`);
      alert('Re-run started! Check the engine logs or refresh history in a few minutes.');
      fetchSessions();
    } catch (err: any) {
      alert('Failed to start re-run: ' + err.message);
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/sessions`);
      setSessions(res.data.sessions || []);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  const loadSessionDetail = async (sessionId: string) => {
    if (expanded === sessionId) {
      setExpanded(null);
      return;
    }
    setExpanded(sessionId);

    // Fetch in parallel
    const [casesRes, resultsRes, sessionRes] = await Promise.allSettled([
      axios.get(`${API_BASE}/api/sessions/${sessionId}/test-cases`),
      axios.get(`${API_BASE}/api/sessions/${sessionId}/results`),
      axios.get(`${API_BASE}/api/sessions/${sessionId}`)
    ]);

    if (casesRes.status === 'fulfilled') {
      setTestCases(prev => ({ ...prev, [sessionId]: casesRes.value.data.testCases }));
    }
    if (resultsRes.status === 'fulfilled') {
      setResults(prev => ({ ...prev, [sessionId]: resultsRes.value.data.results }));
    }
    if (sessionRes.status === 'fulfilled' && sessionRes.value.data.analysis) {
      setAnalysis(prev => ({ ...prev, [sessionId]: sessionRes.value.data.analysis }));
    }

    setActiveDetail(prev => ({ ...prev, [sessionId]: 'cases' }));
  };

  const statusBadge = (status: Session['status']) => {
    if (status === 'COMPLETED') return <span className="session-badge completed"><CheckCircle size={12} /> Completed</span>;
    if (status === 'FAILED')    return <span className="session-badge failed"><XCircle size={12} /> Failed</span>;
    return <span className="session-badge running"><AlertCircle size={12} className="pulse-primary" /> Running</span>;
  };

  const passRate = (sid: string) => {
    const r = results[sid];
    if (!r || r.length === 0) return null;
    const passed = r.filter(x => x.status === 'PASS').length;
    const pct    = Math.round((passed / r.length) * 100);
    return { passed, total: r.length, pct };
  };

  if (loading) {
    return <div style={{ color: 'var(--text-dim)', padding: '2rem', textAlign: 'center' }}>Loading session history...</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', padding: '3rem' }}>
        <FlaskConical size={40} color="var(--text-dim)" style={{ margin: '0 auto 1rem' }} />
        <p style={{ color: 'var(--text-dim)' }}>No sessions yet. Complete a setup run to see history here.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h3 style={{ color: 'var(--primary-glow)' }}>Session History</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{sessions.length} total runs</span>
      </div>

      {sessions.map(s => {
        const rate = passRate(s.sessionId);
        const isOpen = expanded === s.sessionId;
        const detail = activeDetail[s.sessionId] || 'cases';

        return (
          <div key={s.sessionId} className="glass-card session-card">
            {/* Header row */}
            <div className="session-header" onClick={() => loadSessionDetail(s.sessionId)}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '1rem' }}>{s.clientName}</span>
                  {statusBadge(s.status)}
                  {rate && (
                    <span style={{ fontSize: '0.8rem', color: rate.pct >= 80 ? '#00ff88' : '#ffcc00' }}>
                      {rate.passed}/{rate.total} passed ({rate.pct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '0.3rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                  <span><Clock size={10} style={{ marginRight: '4px' }} />{new Date(s.startedAt).toLocaleString()}</span>
                  <span>Branch: <code style={{ color: 'var(--primary-glow)' }}>{s.beBranch}</code></span>
                  <span>Machines: {s.machineCount || '—'}</span>
                  {s.restoredDbName && <span>DB: <code style={{ color: '#ffcc00', fontSize: '0.7rem' }}>{s.restoredDbName}</code></span>}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.2rem', opacity: 0.7 }}>ID: {s.sessionId}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <button 
                  className="rerun-btn" 
                  onClick={(e) => handleRerun(e, s.sessionId)}
                  title="Re-run Session"
                >
                  <RefreshCw size={14} />
                </button>
                <div style={{ color: 'var(--text-dim)' }}>
                  {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{ marginTop: '1rem', borderTop: '1px solid var(--glass-border)', paddingTop: '1rem' }}>
                {/* Tab switcher */}
                <div className="session-tabs">
                  <button className={`session-tab ${detail === 'cases' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'cases' }))}>
                    <FlaskConical size={12} /> Test Cases ({testCases[s.sessionId]?.length || 0})
                  </button>
                  <button className={`session-tab ${detail === 'results' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'results' }))}>
                    <BarChart3 size={12} /> Results ({results[s.sessionId]?.length || 0})
                  </button>
                  <button className={`session-tab ${detail === 'analysis' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'analysis' }))}>
                    AI Analysis
                  </button>
                </div>

                {/* Test Cases */}
                {detail === 'cases' && (
                  <div style={{ marginTop: '0.75rem' }}>
                    {!testCases[s.sessionId]?.length
                      ? <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>No test cases found.</p>
                      : <div className="tc-table">
                          <div className="tc-row tc-header">
                            <span>ID</span><span>Service</span><span>Scenario</span><span>Machine</span><span>Expected</span><span>Source</span>
                          </div>
                          {testCases[s.sessionId].map(tc => (
                            <div key={tc.testId} className="tc-row">
                              <code style={{ color: 'var(--primary-glow)', fontSize: '0.75rem' }}>{tc.testId}</code>
                              <span>{tc.service}</span>
                              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{tc.scenario}</span>
                              <span style={{ fontSize: '0.8rem' }}>{tc.machineName || '—'}</span>
                              <span style={{ color: tc.expectedStatus === 'PASS' ? '#00ff88' : '#ff0055', fontSize: '0.8rem' }}>{tc.expectedStatus}</span>
                              <span style={{ fontSize: '0.7rem', color: tc.generatedBy === 'llm' ? 'var(--secondary-glow)' : 'var(--text-dim)' }}>{tc.generatedBy}</span>
                            </div>
                          ))}
                        </div>
                    }
                  </div>
                )}

                {/* Results */}
                {detail === 'results' && (
                  <div style={{ marginTop: '0.75rem' }}>
                    {!results[s.sessionId]?.length
                      ? <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>No results yet.</p>
                      : <div className="tc-table">
                          <div className="tc-row tc-header">
                            <span>Test ID</span><span>Barcode</span><span>Service</span><span>Status</span><span>Reason</span>
                          </div>
                          {results[s.sessionId].map((r, i) => (
                            <div key={i} className="tc-row">
                              <code style={{ color: 'var(--primary-glow)', fontSize: '0.75rem' }}>{r.testId}</code>
                              <span style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{r.barcode}</span>
                              <span style={{ fontSize: '0.8rem' }}>{r.service}</span>
                              <span style={{
                                color: r.status === 'PASS' ? '#00ff88' : r.status === 'FAIL' ? '#ff0055' : '#ffcc00',
                                fontWeight: 700, fontSize: '0.8rem'
                              }}>{r.status}</span>
                              <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{r.reason || '—'}</span>
                            </div>
                          ))}
                        </div>
                    }
                  </div>
                )}

                {/* AI Analysis */}
                {detail === 'analysis' && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {!analysis[s.sessionId]
                      ? <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>No AI analysis recorded.</p>
                      : <>
                          <div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--primary-glow)', marginBottom: '0.4rem' }}>CODE INSIGHTS</div>
                            <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.6 }}>{analysis[s.sessionId].codeInsights}</p>
                          </div>
                          <div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--primary-glow)', marginBottom: '0.4rem' }}>DATABASE INSIGHTS</div>
                            <p style={{ fontSize: '0.85rem', color: 'var(--text-main)', lineHeight: 1.6 }}>{analysis[s.sessionId].dbInsights}</p>
                          </div>
                          {analysis[s.sessionId].scalingPlan?.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--primary-glow)', marginBottom: '0.4rem' }}>SCALING PLAN</div>
                              {analysis[s.sessionId].scalingPlan.map((sp: any, i: number) => (
                                <div key={i} style={{ fontSize: '0.82rem', marginBottom: '4px' }}>
                                  <span style={{ color: 'var(--secondary-glow)' }}>{sp.service}</span>: {sp.instances}x — {sp.reason}
                                </div>
                              ))}
                            </div>
                          )}
                          {analysis[s.sessionId].failureAnalysis?.length ? (
                            <div>
                              <div style={{ fontSize: '0.75rem', color: '#ff0055', marginBottom: '0.4rem' }}>FAILURE ANALYSIS</div>
                              {analysis[s.sessionId].failureAnalysis!.map((fi, i) => (
                                <div key={i} style={{ fontSize: '0.82rem', color: '#ffcc00', marginBottom: '4px' }}>• {fi}</div>
                              ))}
                            </div>
                          ) : null}
                        </>
                    }
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
