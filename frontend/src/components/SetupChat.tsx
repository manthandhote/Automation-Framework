import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { socket } from '../socket';
import { Send, GitBranch, Upload, Loader, Bot, User, Database, Cpu, CheckCircle } from 'lucide-react';

const API_BASE = 'http://localhost:4200';

type StepId =
  | 'WELCOME'
  | 'CLIENT_NAME'
  | 'BE_REPO'
  | 'BE_BRANCH'
  | 'FE_REPO'
  | 'FE_BRANCH'
  | 'CODE_DIR'
  | 'DB_REPO'       // NEW: user pastes the DataBase_Reference GitHub repo URL
  | 'DB_CLIENT'     // NEW: user picks a client folder (e.g. meesho/astro)
  | 'DISCOVER_MACHINES'
  | 'REVIEW_TEST_CASES'
  | 'CONFIRM'
  | 'RUNNING'
  | 'DONE';

interface ChatMessage {
  id: string;
  role: 'system' | 'user';
  content: string;
  richContent?: React.ReactNode;
  timestamp: Date;
}

interface SetupState {
  clientName: string;
  machineDescriptions: string;
  beRepo: string;
  beBranch: string;
  feRepo: string;
  feBranch: string;
  codeDir: string;
  dbRepoUrl: string;       // NEW: GitHub DB repo URL
  dbClientFolder: string;  // NEW: selected client folder inside configs/
}

const STEP_PROMPTS: Record<StepId, string> = {
  WELCOME: '',
  CLIENT_NAME: '👋 Welcome to **Automyrix Control**! I will guide you through setting up your automated testing environment.\n\nLet\'s start — what is your **client name or project identifier**? (e.g., "CL0002 - Flipkart NMB")',
  BE_REPO: '🖥️ Now I need your **CSND Backend Git repository URL**.\n\nPaste the Azure DevOps or Git URL below:',
  BE_BRANCH: '',
  FE_REPO: '🎨 Now your **FE-CSND Frontend Git repository URL**:',
  FE_BRANCH: '',
  CODE_DIR: '📁 Where should the code be set up locally? Enter the **directory path** (press Enter to use default):',
  DB_REPO: '🗄️ Paste your **Database Reference GitHub repository URL**:\n\n(e.g. `https://github.com/NIDO-MACHINERIES/DataBase_Reference.git`)',
  DB_CLIENT: '📂 Select the **client configuration** to restore:',
  DISCOVER_MACHINES: '🔍 Analyzing database... I have discovered the following machines. Select which one(s) to target for automation:',
  REVIEW_TEST_CASES: '🧪 AI has generated the following **test cases** based on your setup. Please review them:',
  CONFIRM: '',
  RUNNING: '',
  DONE: ''
};

const MACHINE_OPTIONS = [
  { id: 'dws', name: 'DWS Sorter', protocols: ['Capella', 'Astro'] },
  { id: 'scanner', name: 'Barcode Scanner', protocols: ['Capella', 'Generic TCP'] },
  { id: 'profiler', name: 'NIDO Profiler', protocols: ['Capella'] },
  { id: 'weight', name: 'Static Weight Scale', protocols: ['Generic TCP'] },
  { id: 'induction', name: 'Induction Station', protocols: ['Capella'] }
];

export function SetupChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [step, setStep] = useState<StepId>('WELCOME');
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [_beBranches, setBeBranches] = useState<string[]>([]);
  const [_feBranches, setFeBranches] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ step: string; percent: number } | null>(null);
  const [_result, setResult] = useState<any>(null);

  const [setup, setSetup] = useState<SetupState>({
    clientName: '', machineDescriptions: '',
    beRepo: '', beBranch: 'main',
    feRepo: '', feBranch: 'main',
    codeDir: '/data/NIDOWORKZ/',
    dbRepoUrl: '',
    dbClientFolder: '',
  });

  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Socket connection ──────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('setup:progress', (data: { step: string; percent: number }) => {
      setProgress(data);
    });
    socket.on('simulator:packet', (log: { data: string; timestamp: string }) => {
      if (isRunning) addSysMessage(`\`[LOG]\` ${log.data}`);
    });
    return () => {
      socket.off('setup:progress');
      socket.off('simulator:packet');
    };
  }, [isRunning]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setTimeout(() => {
      addSysMessage(STEP_PROMPTS.CLIENT_NAME);
      setStep('CLIENT_NAME');
    }, 500);
  }, []);

  // ─── Helpers ────────────────────────────────────────────────────────────────
  const addSysMessage = (content: string, richContent?: React.ReactNode) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString() + Math.random(),
      role: 'system', content, richContent, timestamp: new Date()
    }]);
  };

  const addUserMessage = (content: string) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString() + Math.random(),
      role: 'user', content, timestamp: new Date()
    }]);
  };

  const simulateTypingThenSay = (msg: string, richContent?: React.ReactNode, delay = 800) => {
    setIsTyping(true);
    setTimeout(() => { setIsTyping(false); addSysMessage(msg, richContent); }, delay);
  };

  const handleMachineConfirm = async (description: string, machineIds: string[], repoUrl?: string, clientFolder?: string) => {
    addUserMessage(`Selected: **${description}**`);
    const updatedSetup = {
      ...setup,
      machineDescriptions: description,
      dbRepoUrl: repoUrl || setup.dbRepoUrl,
      dbClientFolder: clientFolder || setup.dbClientFolder,
    };
    setSetup(updatedSetup);
    setStep('RUNNING');
    setIsRunning(true);
    simulateTypingThenSay('⚙️ **Provisioning environment and generating test cases...** Please wait.');

    try {
      const res = await axios.post(`${API_BASE}/api/setup`, { ...updatedSetup, machineIds });
      const sid = res.data.sessionId;
      setSessionId(sid);
      setProgress(null);
      setTimeout(async () => {
        try {
          const casesRes = await axios.get(`${API_BASE}/api/sessions/${sid}/test-cases`);
          setIsRunning(false);
          setStep('REVIEW_TEST_CASES');
          addSysMessage(STEP_PROMPTS.REVIEW_TEST_CASES,
            <TestCaseReviewer sessionId={sid} cases={casesRes.data.testCases} onConfirm={handleFinalStart} />
          );
        } catch (err: any) {
          addSysMessage(`❌ Failed to fetch test cases: ${err.message}`);
          setStep('DONE');
        }
      }, 4000);
    } catch (err: any) {
      setIsRunning(false);
      addSysMessage(`❌ **Provisioning failed:** ${err.response?.data?.message || err.message}`);
      setStep('DONE');
    }
  };

  const handleFinalStart = async (sid: string) => {
    if (isRunning) return;
    setStep('RUNNING');
    setIsRunning(true);
    simulateTypingThenSay('🚀 **Test cases approved!** Starting automation run...');
    try {
      await axios.post(`${API_BASE}/api/sessions/${sid}/start-tests`);
      const poll = setInterval(async () => {
        try {
          const statusRes = await axios.get(`${API_BASE}/api/sessions/${sid}`);
          if (statusRes.data.session.status === 'COMPLETED') {
            clearInterval(poll);
            setIsRunning(false);
            setStep('DONE');
            simulateTypingThenSay('✅ **Automation run complete!** All test cases have been processed. You can view the full report in the **History** tab.');
          }
        } catch (e) { clearInterval(poll); }
      }, 3000);
    } catch (err: any) {
      setIsRunning(false);
      addSysMessage(`❌ **Execution failed:** ${err.message}`);
    }
  };

  // ─── Step Handler ──────────────────────────────────────────────────────────
  const handleSend = async () => {
    const val = input.trim();

    switch (step) {
      case 'CLIENT_NAME': {
        if (!val) return;
        addUserMessage(val);
        setSetup(s => ({ ...s, clientName: val }));
        setInput('');
        setStep('BE_REPO');
        simulateTypingThenSay(STEP_PROMPTS.BE_REPO);
        break;
      }

      case 'BE_REPO': {
        if (!val) return;
        addUserMessage(val);
        setSetup(s => ({ ...s, beRepo: val }));
        setInput('');
        setIsTyping(true);
        try {
          const res = await axios.get(`${API_BASE}/api/git/branches?url=${encodeURIComponent(val)}`);
          const branches: string[] = res.data.branches || [];
          setBeBranches(branches);
          setIsTyping(false);
          addSysMessage(
            `🌿 Found **${branches.length} branches** in the backend repo. Select which branch to use:`,
            <BranchPicker branches={branches} onSelect={b => handleBranchSelect('be', b)} />
          );
          setStep('BE_BRANCH');
        } catch {
          setIsTyping(false);
          simulateTypingThenSay('⚠️ Could not fetch branches. Defaulting to **main**. Now, your **FE-CSND repository URL**:');
          setSetup(s => ({ ...s, beBranch: 'main' }));
          setStep('FE_REPO');
        }
        break;
      }

      case 'FE_REPO': {
        if (!val) return;
        addUserMessage(val);
        setSetup(s => ({ ...s, feRepo: val }));
        setInput('');
        setIsTyping(true);
        try {
          const res = await axios.get(`${API_BASE}/api/git/branches?url=${encodeURIComponent(val)}`);
          const branches: string[] = res.data.branches || [];
          setFeBranches(branches);
          setIsTyping(false);
          addSysMessage(
            `🌿 Found **${branches.length} branches** for the frontend repo. Select which branch to use:`,
            <BranchPicker branches={branches} onSelect={b => handleBranchSelect('fe', b)} />
          );
          setStep('FE_BRANCH');
        } catch {
          setIsTyping(false);
          simulateTypingThenSay('⚠️ Could not fetch branches. Defaulting to **main**.\n\n' + STEP_PROMPTS.CODE_DIR);
          setSetup(s => ({ ...s, feBranch: 'main' }));
          setStep('CODE_DIR');
        }
        break;
      }

      case 'CODE_DIR': {
        const dir = val || setup.codeDir;
        addUserMessage(val || `*(default) ${setup.codeDir}`);
        setSetup(s => ({ ...s, codeDir: dir }));
        setInput('');
        // Move to DB repo step instead of file upload
        simulateTypingThenSay(STEP_PROMPTS.DB_REPO);
        setStep('DB_REPO');
        break;
      }

      // ── NEW: DB Repo URL input ─────────────────────────────────────────
      case 'DB_REPO': {
        if (!val) return;
        addUserMessage(val);
        setSetup(s => ({ ...s, dbRepoUrl: val }));
        setInput('');
        setIsTyping(true);

        try {
          // Ask backend to clone the repo and return the list of client folders
          const res = await axios.post(`${API_BASE}/api/db-repo/clients`, { repoUrl: val });
          const clients: string[] = res.data.clients || [];
          setIsTyping(false);

          if (clients.length === 0) {
            addSysMessage('⚠️ No client configurations found in that repo. Check the URL and try again.');
            break;
          }

          const capturedUrl = val;
          addSysMessage(
            STEP_PROMPTS.DB_CLIENT,
            <DbClientPicker
              clients={clients}
              onSelect={(folder) => handleClientSelect(folder, capturedUrl)}
            />
          );
          setStep('DB_CLIENT');
        } catch (err: any) {
          setIsTyping(false);
          addSysMessage(`❌ Could not access the DB repository: ${err.response?.data?.error || err.message}`);
        }
        break;
      }

      default:
        break;
    }
  };

  // ── NEW: called when user picks a client folder ────────────────────────────
  const handleClientSelect = async (clientFolder: string, repoUrl: string) => {
    addUserMessage(`Selected config: **${clientFolder}**`);
    setSetup(s => ({ ...s, dbClientFolder: clientFolder, dbRepoUrl: repoUrl }));
    simulateTypingThenSay('🔍 Restoring database and analyzing machine configurations...');
    setStep('DISCOVER_MACHINES');
    try {
      const analysisRes = await axios.post(`${API_BASE}/api/analyze-db`, {
        dbRepoUrl: repoUrl,
        dbClientFolder: clientFolder,
      });
      const machines: string[] = analysisRes.data.machines || [];

      if (machines.length === 0) {
        addSysMessage('⚠️ No machines found. You can enter them manually:', <MachineSelector onConfirm={handleMachineConfirm} />);
      } else {
        addSysMessage(
          `✅ Discovered **${machines.length} machines** in your database:`,
          <DiscoveredMachinesPicker
            machines={machines}
            onConfirm={(desc, ids) => handleMachineConfirm(desc, ids, repoUrl, clientFolder)}
          />
        );
      }
    } catch (err: any) {
      addSysMessage(`❌ DB analysis failed: ${err.response?.data?.error || err.message}`);
      setStep('DONE');
    }
  };

  const handleBranchSelect = (target: 'be' | 'fe', branch: string) => {
    if (target === 'be') {
      setSetup(s => ({ ...s, beBranch: branch }));
      addUserMessage(`Selected branch: **${branch}**`);
      simulateTypingThenSay(STEP_PROMPTS.FE_REPO);
      setStep('FE_REPO');
    } else {
      setSetup(s => ({ ...s, feBranch: branch }));
      addUserMessage(`Selected branch: **${branch}**`);
      simulateTypingThenSay(STEP_PROMPTS.CODE_DIR);
      setStep('CODE_DIR');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ─── Input area config per step ──────────────────────────────────────────────
  const isInputVisible = ['CLIENT_NAME', 'BE_REPO', 'FE_REPO', 'CODE_DIR', 'DB_REPO'].includes(step);
  const isDoneStep = step === 'DONE';
  const isRunningStep = step === 'RUNNING';

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="setup-chat-wrapper">
      {/* Branding Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '1.25rem 1.5rem',
        borderBottom: '1px solid var(--glass-border)', background: 'rgba(13, 17, 23, 0.4)',
        backdropFilter: 'blur(20px)', gap: '1rem'
      }}>
        <div style={{
          width: '32px', height: '32px', background: 'var(--primary-glow)', borderRadius: '8px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 15px rgba(0, 242, 255, 0.3)'
        }}>
          <Bot size={20} color="#000" />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '0.5px', color: '#fff' }}>Setup Intelligence</div>
            <div className="badge badge-warning" style={{ fontSize: '0.6rem', padding: '2px 8px' }}>NEURAL ENGINE v1.0</div>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontWeight: 500 }}>Configuring Autonomous Testing Environment</div>
        </div>
      </div>

      {/* Message Area */}
      <div className="chat-container">
        {messages.map(msg => (
          <div key={msg.id} className={`chat-message ${msg.role}`}>
            <div className="chat-avatar">
              {msg.role === 'system'
                ? <Bot size={16} color="var(--primary-glow)" />
                : <User size={16} color="var(--secondary-glow)" />}
            </div>
            <div className="chat-bubble">
              <MarkdownText text={msg.content} />
              {msg.richContent && <div className="chat-rich-content">{msg.richContent}</div>}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="chat-message system">
            <div className="chat-avatar"><Bot size={16} color="var(--primary-glow)" /></div>
            <div className="chat-bubble">
              <div className="chat-typing"><span /><span /><span /></div>
            </div>
          </div>
        )}

        {isRunningStep && progress && (
          <div className="chat-progress-bar">
            <div className="chat-progress-label">
              <span>{progress.step}</span><span>{progress.percent}%</span>
            </div>
            <div className="chat-progress-track">
              <div className="chat-progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input Area */}
      <div className="chat-input-row">
        {isInputVisible && (
          <>
            <textarea
              className="chat-input"
              placeholder={
                step === 'CLIENT_NAME' ? 'e.g. CL0002 — Flipkart NMB' :
                  step === 'BE_REPO' ? 'https://dev.azure.com/org/repo/_git/CSND' :
                    step === 'FE_REPO' ? 'https://dev.azure.com/org/repo/_git/FE-CSND' :
                      step === 'CODE_DIR' ? `Press Enter for default: ${setup.codeDir}` :
                        step === 'DB_REPO' ? 'https://github.com/NIDO-MACHINERIES/DataBase_Reference.git' :
                          'Type your message...'
              }
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={!input.trim() && step !== 'CODE_DIR'}
            >
              <Send size={18} />
            </button>
          </>
        )}

        {(step === 'DB_CLIENT' || step === 'DISCOVER_MACHINES' || step === 'CONFIRM' || isDoneStep || isRunningStep) && !isInputVisible && (
          <div className="chat-input-hint">
            {isRunningStep ? '⏳ Provisioning in progress...' : isDoneStep ? '✅ Setup complete — check History tab' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  NEW: DbClientPicker — shows client folder buttons from the DB repo
// ══════════════════════════════════════════════════════════════════════════════
function DbClientPicker({ clients, onSelect }: { clients: string[]; onSelect: (folder: string) => void }) {
  return (
    <div className="chat-branch-picker">
      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
        <Database size={12} style={{ marginRight: '4px' }} /> Choose client config to restore:
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {clients.map(c => (
          <button key={c} className="branch-chip" onClick={() => onSelect(c)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <GitBranch size={12} /> {c}
          </button>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Sub-components (unchanged from original)
// ══════════════════════════════════════════════════════════════════════════════

function TestCaseReviewer({ sessionId, cases, onConfirm }: { sessionId: string, cases: any[], onConfirm: (sid: string) => void }) {
  return (
    <div className="test-case-reviewer">
      <div className="test-case-list" style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '1rem' }}>
        {cases.map((c, i) => (
          <div key={i} className="test-case-item" style={{
            background: 'rgba(255,255,255,0.05)', padding: '0.75rem', borderRadius: '8px',
            marginBottom: '0.75rem', border: '1px solid rgba(255,255,255,0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <span style={{ color: 'var(--primary-glow)', fontSize: '0.7rem', fontWeight: 600 }}>{c.testId}</span>
              <span style={{
                fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px',
                background: c.expectedStatus === 'PASS' ? 'rgba(0,255,136,0.1)' : 'rgba(255,77,77,0.1)',
                color: c.expectedStatus === 'PASS' ? '#00ff88' : '#ff4d4d'
              }}>{c.expectedStatus}</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.25rem' }}>{c.scenario}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.7, lineHeight: '1.4' }}>{c.description}</div>
            {c.barcode && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                Barcode: <code style={{ color: 'var(--secondary-glow)' }}>{c.barcode}</code>
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="confirm-btn" onClick={() => onConfirm(sessionId)}>
        <CheckCircle size={16} style={{ marginRight: '8px' }} />
        Approve & Start Automation
      </button>
    </div>
  );
}

function DiscoveredMachinesPicker({ machines, onConfirm }: {
  machines: { id: string, name: string }[],
  onConfirm: (desc: string, machineIds: string[]) => void
}) {
  const [selected, setSelected] = useState<{ id: string, name: string }[]>([]);
  const toggle = (m: { id: string, name: string }) => {
    setSelected(prev => prev.find(x => x.id === m.id) ? prev.filter(x => x.id !== m.id) : [...prev, m]);
  };
  return (
    <div className="machine-selector">
      <div className="machine-grid">
        {machines.map(m => (
          <div key={m.id} className={`machine-item ${selected.find(x => x.id === m.id) ? 'active' : ''}`} onClick={() => toggle(m)}>
            <span className="machine-name">{m.name}</span>
          </div>
        ))}
      </div>
      <button className="confirm-btn" disabled={selected.length === 0}
        onClick={() => onConfirm(selected.map(m => m.name).join(', '), selected.map(m => m.id))}>
        Target Selected Machines ({selected.length})
      </button>
    </div>
  );
}

function MachineSelector({ onConfirm }: { onConfirm: (desc: string) => void }) {
  const [selected, setSelected] = useState<{ id: string, count: number, protocol: string }[]>([]);
  const toggleMachine = (m: typeof MACHINE_OPTIONS[0]) => {
    const exists = selected.find(s => s.id === m.id);
    if (exists) setSelected(selected.filter(s => s.id !== m.id));
    else setSelected([...selected, { id: m.id, count: 1, protocol: m.protocols[0] }]);
  };
  const updateCount = (id: string, delta: number) => {
    setSelected(selected.map(s => s.id === id ? { ...s, count: Math.max(1, s.count + delta) } : s));
  };
  const updateProtocol = (id: string, protocol: string) => {
    setSelected(selected.map(s => s.id === id ? { ...s, protocol } : s));
  };
  const handleDone = () => {
    if (selected.length === 0) return;
    const desc = selected.map(s => {
      const opt = MACHINE_OPTIONS.find(o => o.id === s.id);
      return `${s.count} ${opt?.name} (${s.protocol})`;
    }).join(', ');
    onConfirm(desc);
  };
  return (
    <div className="machine-selector">
      <div className="machine-grid">
        {MACHINE_OPTIONS.map(m => {
          const isSelected = selected.find(s => s.id === m.id);
          return (
            <div key={m.id} className={`machine-item ${isSelected ? 'active' : ''}`} onClick={() => toggleMachine(m)}>
              <div className="machine-info">
                <span className="machine-name">{m.name}</span>
                {isSelected && (
                  <div className="machine-controls" onClick={e => e.stopPropagation()}>
                    <div className="count-ctrl">
                      <button onClick={() => updateCount(m.id, -1)}>-</button>
                      <span>{isSelected.count}</span>
                      <button onClick={() => updateCount(m.id, 1)}>+</button>
                    </div>
                    <select value={isSelected.protocol} onChange={e => updateProtocol(m.id, e.target.value)}>
                      {m.protocols.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button className="confirm-btn" disabled={selected.length === 0} onClick={handleDone}>
        Confirm Configuration
      </button>
    </div>
  );
}

function BranchPicker({ branches, onSelect }: { branches: string[]; onSelect: (b: string) => void }) {
  const sorted = [...branches].sort((a, b) => {
    if (a === 'master' || a === 'main') return -1;
    if (b === 'master' || b === 'main') return 1;
    return a.localeCompare(b);
  });
  return (
    <div className="chat-branch-picker">
      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.5rem' }}>
        <GitBranch size={12} style={{ marginRight: '4px' }} /> Select branch:
      </div>
      <div className="branch-list" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', maxHeight: '120px', overflowY: 'auto' }}>
        {sorted.slice(0, 50).map(b => (
          <button key={b} className="branch-chip" onClick={() => onSelect(b)}>{b}</button>
        ))}
      </div>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="chat-md">
      {lines.map((line, i) => {
        if (line.startsWith('| ')) {
          return <span key={i} style={{ display: 'block', fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-dim)' }}>{line}</span>;
        }
        const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        return (
          <span key={i} style={{ display: 'block', lineHeight: '1.6' }}>
            {parts.map((p, j) => {
              if (p.startsWith('**') && p.endsWith('**')) return <strong key={j}>{p.slice(2, -2)}</strong>;
              if (p.startsWith('`') && p.endsWith('`')) return <code key={j} style={{ background: 'rgba(0,242,255,0.1)', padding: '0 4px', borderRadius: '4px', fontFamily: 'monospace' }}>{p.slice(1, -1)}</code>;
              return p;
            })}
          </span>
        );
      })}
    </div>
  );
}