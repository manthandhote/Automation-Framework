import { useState, useEffect } from 'react';
import axios from 'axios';
import { Clock, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp, FlaskConical, BarChart3, RefreshCw, Cpu, Database, Zap } from 'lucide-react';

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
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleRerun = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!confirm('Re-run this session? Existing results will be updated.')) return;
    try {
      await axios.post(`${API_BASE}/api/sessions/${sessionId}/rerun`);
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

  // CORRECTED Pass Rate Logic: Compare actual status with expected status
  const passRate = (sid: string) => {
    const r = results[sid];
    const c = testCases[sid];
    if (!r || r.length === 0 || !c) return null;

    let passed = 0;
    r.forEach(res => {
       const tc = c.find(x => x.testId === res.testId);
       if (tc) {
          // If actual matches expected, it's a pass for the test case
          if (res.status === tc.expectedStatus) passed++;
       } else if (res.status === 'PASS') {
          passed++; // fallback
       }
    });

    const pct = Math.round((passed / r.length) * 100);
    return { passed, total: r.length, pct };
  };

  if (loading) {
    return <div style={{ color: 'var(--text-dim)', padding: '2rem', textAlign: 'center' }}>Loading session history...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Execution Logs</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', background: 'rgba(255,255,255,0.05)', padding: '4px 12px', borderRadius: '20px' }}>
          {sessions.length} sessions tracked
        </span>
      </div>

      {sessions.map(s => {
        const rate = passRate(s.sessionId);
        const isOpen = expanded === s.sessionId;
        const detail = activeDetail[s.sessionId] || 'cases';

        return (
          <div key={s.sessionId} className="glass-card" style={{ padding: '0' }}>
            <div 
              style={{ padding: '1.5rem', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onClick={() => loadSessionDetail(s.sessionId)}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                   <span style={{ fontSize: '1.1rem', fontWeight: 800 }}>{s.clientName}</span>
                   {statusBadge(s.status)}
                   {rate && (
                     <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ width: '100px', height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                           <div style={{ width: `${rate.pct}%`, height: '100%', background: rate.pct === 100 ? 'var(--accent-green)' : 'var(--accent-gold)' }} />
                        </div>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: rate.pct === 100 ? 'var(--accent-green)' : 'var(--accent-gold)' }}>
                           {rate.passed}/{rate.total} PASSED
                        </span>
                     </div>
                   )}
                </div>
                <div style={{ display: 'flex', gap: '2rem', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Clock size={14} /> {new Date(s.startedAt).toLocaleString()}</div>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Zap size={14} color="var(--primary-glow)" /> {s.beBranch}</div>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Database size={14} color="var(--accent-gold)" /> {s.restoredDbName || 'standard_csnd'}</div>
                </div>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                 <button className="rerun-btn" onClick={(e) => handleRerun(e, s.sessionId)}>
                    <RefreshCw size={14} />
                 </button>
                 {isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>
            </div>

            {isOpen && (
              <div style={{ padding: '0 1.5rem 1.5rem', borderTop: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.1)' }}>
                <div className="session-tabs" style={{ margin: '1rem 0' }}>
                  <button className={`session-tab ${detail === 'cases' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'cases' }))}>
                    <FlaskConical size={14} /> Scenarios ({testCases[s.sessionId]?.length || 0})
                  </button>
                  <button className={`session-tab ${detail === 'results' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'results' }))}>
                    <BarChart3 size={14} /> Live Results ({results[s.sessionId]?.length || 0})
                  </button>
                  <button className={`session-tab ${detail === 'analysis' ? 'active' : ''}`} onClick={() => setActiveDetail(p => ({ ...p, [s.sessionId]: 'analysis' }))}>
                    <Cpu size={14} /> AI Context
                  </button>
                </div>

                {detail === 'cases' && (
                  <div className="tc-table">
                    <div className="tc-row tc-header">
                      <span>Ref</span><span>Component</span><span>Scenario Description</span><span>Target</span><span>Expect</span><span>Type</span>
                    </div>
                    {testCases[s.sessionId]?.map(tc => (
                      <div key={tc.testId} className="tc-row">
                        <code style={{ color: 'var(--primary-glow)' }}>{tc.testId}</code>
                        <span style={{ fontWeight: 600 }}>{tc.service.replace('-service', '')}</span>
                        <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{tc.scenario}</span>
                        <span style={{ fontSize: '0.8rem' }}>{tc.machineName || 'GLOBAL'}</span>
                        <span style={{ color: tc.expectedStatus === 'PASS' ? 'var(--accent-green)' : 'var(--accent-pink)', fontWeight: 700 }}>{tc.expectedStatus}</span>
                        <span style={{ fontSize: '0.65rem', opacity: 0.6 }}>{tc.generatedBy.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                )}

                {detail === 'results' && (
                  <div className="tc-table">
                    <div className="tc-row tc-header">
                      <span>Test ID</span><span>Trace ID (Barcode)</span><span>Microservice</span><span>Actual</span><span>Logic Reason</span>
                    </div>
                    {results[s.sessionId]?.map((r, i) => {
                       const tc = testCases[s.sessionId]?.find(x => x.testId === r.testId);
                       const isCorrectOutcome = tc ? r.status === tc.expectedStatus : r.status === 'PASS';
                       
                       return (
                        <div key={i} className="tc-row">
                          <code>{r.testId}</code>
                          <span style={{ fontFamily: 'monospace', color: 'var(--primary-glow)', fontSize: '0.8rem' }}>{r.barcode}</span>
                          <span style={{ fontSize: '0.8rem' }}>{r.service}</span>
                          <span style={{ 
                            color: isCorrectOutcome ? 'var(--accent-green)' : 'var(--accent-pink)',
                            fontWeight: 800
                          }}>
                            {r.status} {isCorrectOutcome ? '✓' : '✗'}
                          </span>
                          <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{r.reason || 'No specific trace data'}</span>
                        </div>
                       );
                    })}
                  </div>
                )}

                {detail === 'analysis' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '1rem' }}>
                    {analysis[s.sessionId] ? (
                      <>
                        <div className="glass-card" style={{ background: 'rgba(0,242,255,0.02)' }}>
                           <h5 style={{ color: 'var(--primary-glow)', marginBottom: '0.5rem', fontSize: '0.8rem' }}>CODEBASE ANALYSIS</h5>
                           <p style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>{analysis[s.sessionId].codeInsights}</p>
                        </div>
                        <div className="glass-card" style={{ background: 'rgba(255,204,0,0.02)' }}>
                           <h5 style={{ color: 'var(--accent-gold)', marginBottom: '0.5rem', fontSize: '0.8rem' }}>DATABASE INTEGRITY</h5>
                           <p style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>{analysis[s.sessionId].dbInsights}</p>
                        </div>
                      </>
                    ) : <p>No AI analysis available for this session.</p>}
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
