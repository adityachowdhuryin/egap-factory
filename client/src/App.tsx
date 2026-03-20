
import React, { useEffect, useState, useRef } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

// ── Types ────────────────────────────────────────────────────────────
interface Tool {
    id: string;
    name: string;
    description?: string;
}

interface AgentFormData {
    name: string;
    role: string;
    goal: string;
    systemPrompt: string;
    tools: string[];
    budgetUsd: number;
}

interface Message {
    id: string;
    role: string;
    content: string;
    createdAt: string;
}

interface DashboardStats {
    totalCost: number;
    activeAgents: number;
    pendingTasks: number;
    zombieCount: number;
    traces: any[];
    perAgentCosts: { agentId: string; agentName: string; totalCost: number; totalTokens: number; invocations: number }[];
}

interface Task {
    id: string;
    description: string;
    status: string;
    inputPayload: any;
    createdAt: string;
    agent?: { name: string };
}

interface CostTimeseries {
    date: string;
    agentName: string;
    totalCost: number;
    totalTokens: number;
}

interface AgentTotal {
    agentId: string;
    agentName: string;
    totalCost: number;
    totalTokens: number;
}

// ── App Component ────────────────────────────────────────────────────
function App() {
    // State: UI
    const [currentUserRole, setCurrentUserRole] = useState<'admin' | 'user' | null>(null);
    const [activeTab, setActiveTab] = useState<'create' | 'tools' | 'test' | 'govern' | 'observe' | 'analytics'>('test');
    const [_loading, setLoading] = useState(true);
    const [successMessage, setSuccessMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    // State: Emergency Stop
    const [emergencyActive, setEmergencyActive] = useState(false);

    // State: Create Agent
    const [tools, setTools] = useState<Tool[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
    const [formData, setFormData] = useState<AgentFormData>({
        name: '', role: '', goal: '', systemPrompt: '', tools: [], budgetUsd: 5.0,
    });

    // State: Version History
    const [versionHistoryAgentId, setVersionHistoryAgentId] = useState<string | null>(null);
    const [versionHistory, setVersionHistory] = useState<any[]>([]);
    const [loadingVersions, setLoadingVersions] = useState(false);

    // State: Create Tool
    const [toolFormData, setToolFormData] = useState({ name: '', description: '', parameters: '' });
    const [submittingTool, setSubmittingTool] = useState(false);

    // State: Test Flight
    const [selectedAgentId, setSelectedAgentId] = useState<string>('');
    const [agents, setAgents] = useState<any[]>([]);
    const [testMessage, setTestMessage] = useState('');
    const [chatHistory, setChatHistory] = useState<Message[]>([]);
    const [streamingContent, setStreamingContent] = useState('');
    const wsRef = useRef<WebSocket | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // State: Command Plane
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [reconciliation, setReconciliation] = useState<any>(null);

    // State: Analytics
    const [costTimeseries, setCostTimeseries] = useState<CostTimeseries[]>([]);
    const [agentTotals, setAgentTotals] = useState<AgentTotal[]>([]);

    // State: Task Editing
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
    const [editingPayload, setEditingPayload] = useState<string>('');
    const [savingTask, setSavingTask] = useState(false);

    // State: Governance — Audit Log & Task Filtering
    const [auditLogs, setAuditLogs] = useState<any[]>([]);
    const [allTasks, setAllTasks] = useState<any[]>([]);
    const [taskStatusFilter, setTaskStatusFilter] = useState('ALL');
    const [taskAgentFilter, setTaskAgentFilter] = useState('');
    const [taskSearchQuery, setTaskSearchQuery] = useState('');
    const [commentText, setCommentText] = useState('');
    const [commentingTaskId, setCommentingTaskId] = useState<string | null>(null);

    // State: Observability — Enhanced
    const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
    const [traceSpans, setTraceSpans] = useState<any[]>([]);
    const [errorLogs, setErrorLogs] = useState<any[]>([]);
    const [activityAgentId, setActivityAgentId] = useState<string>('');
    const [activityTimeline, setActivityTimeline] = useState<any[]>([]);
    const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
    const [messageDetail, setMessageDetail] = useState<any>(null);

    // ── Effects ──────────────────────────────────────────────────────
    useEffect(() => {
        fetchTools();
        fetchAgents();
        fetchEmergencyStatus();
    }, []);

    useEffect(() => {
        // Immediately fetch data when switching to a tab (no 3s delay)
        if (activeTab === 'govern') { fetchTasks(); fetchAllTasks(); fetchAuditLogs(); }
        if (activeTab === 'observe') { fetchStats(); fetchReconciliation(); fetchErrorLogs(); }
        if (activeTab === 'analytics') fetchCostTimeseries();

        // Only poll chat if we're not streaming a response
        const interval = setInterval(() => {
            if (activeTab === 'test' && selectedAgentId && !Object.values(chatHistory).some(m => m.id.startsWith('temp-') || streamingContent)) {
                fetchMessages();
            }

            if (activeTab === 'observe') { fetchStats(); fetchReconciliation(); fetchErrorLogs(); }
            if (activeTab === 'govern') { fetchTasks(); fetchAllTasks(); fetchAuditLogs(); }
            if (activeTab === 'analytics') fetchCostTimeseries();
            fetchEmergencyStatus(); // Always poll safety status
        }, 3000);
        return () => clearInterval(interval);
    }, [activeTab, selectedAgentId]);

    // WebSocket Connection for Agent Thought Streaming
    useEffect(() => {
        if (!selectedAgentId || activeTab !== 'test') return;

        // Connect to the Orchestrator WebSocket (running on port 8080)
        const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?agentId=${selectedAgentId}`);

        ws.onopen = () => console.log('🔌 Connected to Agent Stream');
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'thought_chunk') {
                    setStreamingContent(prev => prev + data.text);
                }
                if (data.type === 'hitl_task_created') {
                    fetchTasks(); // Refresh tasks immediately
                    setSuccessMessage(`🔒 HITL Approval Required: ${data.task?.description || 'New task pending'}`);
                }
            } catch (e) { console.error('WS Parse Error', e); }
        };
        ws.onclose = () => console.log('🔌 Disconnected from Agent Stream');

        wsRef.current = ws;

        return () => {
            ws.close();
        };
    }, [selectedAgentId, activeTab]);

    // Auto-scroll to bottom only when chat length changes or streaming updates
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory.length, streamingContent]);

    // ── API Calls ────────────────────────────────────────────────────
    const fetchTools = async () => {
        try {
            const res = await fetch('/api/tools');
            if (res.ok) setTools(await res.json());
            setLoading(false);
        } catch (error) { console.error(error); }
    };

    const fetchAgents = async () => {
        try {
            const res = await fetch('/.well-known/agent.json');
            if (res.ok) {
                const data = await res.json();
                setAgents(data.agents || []);
            }
        } catch (error) { console.error(error); }
    };

    const fetchEmergencyStatus = async () => {
        try {
            const res = await fetch('/api/settings/emergency');
            if (res.ok) {
                const data = await res.json();
                setEmergencyActive(data.active);
            }
        } catch (e) { console.error(e); }
    };

    const toggleEmergency = async () => {
        try {
            const res = await fetch('/api/settings/emergency', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: !emergencyActive })
            });
            if (res.ok) {
                setEmergencyActive(!emergencyActive);
                if (!emergencyActive) setErrorMessage('🛑 EMERGENCY STOP ACTIVATED');
                else setSuccessMessage('✅ System Resumed');
            }
        } catch (e) { console.error(e); }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch('/api/dashboard/stats');
            if (res.ok) setStats(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchReconciliation = async () => {
        try {
            const res = await fetch('/api/reports/reconciliation');
            if (res.ok) setReconciliation(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchTasks = async () => {
        try {
            const res = await fetch('/api/tasks');
            if (res.ok) setTasks(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchCostTimeseries = async () => {
        try {
            const res = await fetch('/api/dashboard/cost-timeseries');
            if (res.ok) {
                const data = await res.json();
                setCostTimeseries(data.timeseries || []);
                setAgentTotals(data.agentTotals || []);
            }
        } catch (e) { console.error(e); }
    };

    const fetchMessages = async () => {
        if (!selectedAgentId) return;
        try {
            const res = await fetch(`/api/agents/${selectedAgentId}/messages`);
            if (res.ok) setChatHistory(await res.json());
        } catch (e) { console.error(e); }
    };

    // ── Governance API Calls ──────────────────────────────────────
    const fetchAuditLogs = async () => {
        try {
            const res = await fetch('/api/audit-logs?limit=50');
            if (res.ok) setAuditLogs(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchAllTasks = async () => {
        try {
            const params = new URLSearchParams();
            if (taskStatusFilter !== 'ALL') params.set('status', taskStatusFilter);
            if (taskAgentFilter) params.set('agentId', taskAgentFilter);
            if (taskSearchQuery) params.set('search', taskSearchQuery);
            const res = await fetch(`/api/tasks/all?${params.toString()}`);
            if (res.ok) setAllTasks(await res.json());
        } catch (e) { console.error(e); }
    };

    const handleAddComment = async (taskId: string) => {
        if (!commentText.trim()) return;
        try {
            const res = await fetch(`/api/tasks/${taskId}/comment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: commentText }),
            });
            if (res.ok) {
                setCommentText('');
                setSuccessMessage('Comment added!');
                fetchAllTasks();
                fetchAuditLogs();
            }
        } catch (e) { setErrorMessage('Failed to add comment'); }
    };

    // ── Observability API Calls ───────────────────────────────────
    const fetchTraceSpans = async (traceId: string) => {
        try {
            const res = await fetch(`/api/traces/${traceId}/spans`);
            if (res.ok) setTraceSpans(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchErrorLogs = async () => {
        try {
            const res = await fetch('/api/error-logs?limit=30');
            if (res.ok) setErrorLogs(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchAgentActivity = async (agentId: string) => {
        try {
            const res = await fetch(`/api/agents/${agentId}/activity?limit=50`);
            if (res.ok) setActivityTimeline(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchMessageDetail = async (messageId: string) => {
        try {
            const res = await fetch(`/api/messages/${messageId}/detail`);
            if (res.ok) setMessageDetail(await res.json());
        } catch (e) { console.error(e); }
    };

    // ── SLA Timer Helper ──────────────────────────────────────────
    const getSlaInfo = (createdAt: string) => {
        const elapsed = Date.now() - new Date(createdAt).getTime();
        const minutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(minutes / 60);
        const display = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
        let color = 'text-green-400 border-green-500/30 bg-green-900/20';
        if (minutes >= 30) color = 'text-red-400 border-red-500/30 bg-red-900/20';
        else if (minutes >= 5) color = 'text-yellow-400 border-yellow-500/30 bg-yellow-900/20';
        return { display, color, minutes };
    };

    // ── Handlers ─────────────────────────────────────────────────────
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleToolToggle = (toolName: string) => {
        setFormData(prev => ({
            ...prev,
            tools: prev.tools.includes(toolName) ? prev.tools.filter(n => n !== toolName) : [...prev.tools, toolName],
        }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const url = editingAgentId
                ? `/api/agents/${editingAgentId}`
                : '/api/agents';
            const method = editingAgentId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData),
            });
            if (!res.ok) throw new Error('Failed');
            setSuccessMessage(`🎉 Agent ${editingAgentId ? 'updated' : 'deployed'} successfully!`);
            
            // If we just updated an agent, trigger a background redeployment to Vertex AI
            if (editingAgentId && url.includes(editingAgentId)) {
                fetch(`/api/agents/${editingAgentId}/redeploy`, { method: 'POST' })
                    .catch(e => console.error("Background redeploy failed:", e));
            }

            setFormData({ name: '', role: '', goal: '', systemPrompt: '', tools: [], budgetUsd: 5.0 });
            setEditingAgentId(null);
            fetchAgents();
        } catch (err) { setErrorMessage(`Failed to ${editingAgentId ? 'update' : 'deploy'} agent.`); }
        finally { setSubmitting(false); }
    };

    const handleToolSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmittingTool(true);
        try {
            // Parse parameters to ensure it's valid JSON before sending
            let parsedParams = {};
            if (toolFormData.parameters.trim()) {
                parsedParams = JSON.parse(toolFormData.parameters);
            }

            const res = await fetch('/api/tools', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: toolFormData.name,
                    description: toolFormData.description,
                    parameters: parsedParams
                }),
            });
            if (!res.ok) throw new Error('Failed');
            setSuccessMessage(`🎉 Tool created successfully!`);
            setToolFormData({ name: '', description: '', parameters: '' });
            fetchTools();
        } catch (err) { setErrorMessage('Failed to create tool. Check JSON formatting.'); }
        finally { setSubmittingTool(false); }
    };

    const handleEditClick = (agent: any) => {
        setEditingAgentId(agent.id);
        const agentToolIds = agent.tools?.map((t: any) => t.name) || [];
        setFormData({
            name: agent.name,
            role: agent.role,
            goal: agent.goal,
            systemPrompt: agent.systemPrompt,
            tools: agentToolIds,
            budgetUsd: agent.budgetUsd ?? 5.0
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleViewVersions = async (agentId: string) => {
        setVersionHistoryAgentId(agentId);
        setLoadingVersions(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/versions`);
            const data = await res.json();
            setVersionHistory(data);
        } catch { setVersionHistory([]); }
        finally { setLoadingVersions(false); }
    };

    const handleRollback = async (agentId: string, version: number) => {
        if (!window.confirm(`Rollback to version ${version}? Current state will be saved as a new version.`)) return;
        try {
            const res = await fetch(`/api/agents/${agentId}/rollback/${version}`, { method: 'POST' });
            if (res.ok) {
                setSuccessMessage(`↩️ Agent rolled back to version ${version}!`);
                setVersionHistoryAgentId(null);
                fetchAgents();
            } else { setErrorMessage('Failed to rollback agent.'); }
        } catch { setErrorMessage('Rollback failed.'); }
    };

    const handleReactivate = async (agentId: string) => {
        try {
            const res = await fetch(`/api/agents/${agentId}/reactivate`, { method: 'POST' });
            if (res.ok) {
                setSuccessMessage('🔄 Agent reactivated!');
                fetchAgents();
            } else { setErrorMessage('Failed to reactivate agent.'); }
        } catch { setErrorMessage('Reactivation failed.'); }
    };

    const handleDeleteAgent = async (id: string) => {
        if (!window.confirm("Are you sure you want to delete this agent? This permanently erases its history and tasks.")) return;
        try {
            const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setSuccessMessage('Agent deleted successfully.');
                if (editingAgentId === id) {
                    setEditingAgentId(null);
                    setFormData({ name: '', role: '', goal: '', systemPrompt: '', tools: [], budgetUsd: 5.0 });
                }
                if (selectedAgentId === id) {
                    setSelectedAgentId('');
                    setChatHistory([]);
                }
                fetchAgents();
            } else {
                setErrorMessage('Failed to delete agent.');
            }
        } catch (e) { setErrorMessage('Failed to delete agent.'); }
    };

    const handleTestSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!testMessage.trim() || !selectedAgentId) return;
        const msg = testMessage;
        setTestMessage('');
        setStreamingContent(''); // Reset stream on new message

        // Optimistically add the user message
        setChatHistory(prev => [...prev, {
            id: 'temp-' + Date.now(),
            agentId: selectedAgentId,
            role: 'user',
            content: msg,
            createdAt: new Date().toISOString()
        } as Message]);

        try {
            await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: selectedAgentId, message: msg }),
            });
            // Fetch immediately after the agent responds (avoids waiting for next 3s poll)
            await fetchMessages();
        } catch (err) { setErrorMessage('Failed to send message.'); }
    };

    const handleClearChat = async () => {
        if (!selectedAgentId) return;
        if (!window.confirm("Are you sure you want to clear the chat history for this agent?")) return;
        try {
            const res = await fetch(`/api/agents/${selectedAgentId}/messages`, { method: 'DELETE' });
            if (res.ok) {
                setChatHistory([]);
                setSuccessMessage('Chat history cleared!');
            } else {
                setErrorMessage('Failed to clear chat.');
            }
        } catch (e) { setErrorMessage('Failed to clear chat.'); }
    };

    const handleVote = async (taskId: string, action: 'approve' | 'reject') => {
        try {
            const res = await fetch(`/api/tasks/${taskId}/${action}`, { method: 'POST' });
            if (res.ok) {
                setSuccessMessage(`Task ${action}d!`);
                setEditingTaskId(null);
                fetchTasks();
            }
        } catch (e) { setErrorMessage('Action failed'); }
    };

    const handleEditTask = (task: Task) => {
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
            return;
        }
        setEditingTaskId(task.id);
        setEditingPayload(JSON.stringify(task.inputPayload || {}, null, 2));
    };

    const handleSaveTaskEdit = async (taskId: string) => {
        setSavingTask(true);
        try {
            let parsedPayload;
            try {
                parsedPayload = JSON.parse(editingPayload);
            } catch {
                setErrorMessage('Invalid JSON in payload editor.');
                setSavingTask(false);
                return;
            }

            const res = await fetch(`/api/tasks/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputPayload: parsedPayload }),
            });

            if (res.ok) {
                setSuccessMessage('✅ Task payload updated!');
                fetchTasks();
            } else {
                const data = await res.json();
                setErrorMessage(data.error || 'Failed to update task.');
            }
        } catch (e) { setErrorMessage('Failed to save task edit.'); }
        finally { setSavingTask(false); }
    };

    // ── Render ───────────────────────────────────────────────────────
    if (!currentUserRole) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
                <div className="bg-gray-800/80 backdrop-blur-xl border border-gray-700 p-8 rounded-3xl shadow-2xl max-w-md w-full text-center">
                    <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-400 via-pink-500 to-red-500 bg-clip-text text-transparent mb-2">EGAP</h1>
                    <p className="text-gray-400 mb-8">Select your role to continue</p>

                    <div className="space-y-4">
                        <button
                            onClick={() => { setCurrentUserRole('admin'); setActiveTab('create'); }}
                            className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 rounded-xl font-bold text-white shadow-lg transition-all"
                        >
                            Login as Admin
                        </button>
                        <button
                            onClick={() => { setCurrentUserRole('user'); setActiveTab('test'); }}
                            className="w-full py-4 bg-gray-700 hover:bg-gray-600 border border-gray-600 text-white rounded-xl font-bold shadow-lg transition-all"
                        >
                            Login as User
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`min-h-screen transition-colors duration-500 ${emergencyActive ? 'bg-red-950/30' : 'bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900'} py-8 px-4 sm:px-6 lg:px-8 text-white`}>
            <div className="max-w-6xl mx-auto">

                {/* Header & Emergency Stop */}
                <div className="flex justify-between items-center mb-10">
                    <div>
                        <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-400 via-pink-500 to-red-500 bg-clip-text text-transparent">
                            EGAP Command Plane
                        </h1>
                        <p className="mt-2 text-gray-400">Enterprise Grade Agent Platform</p>
                    </div>
                    <div className="flex items-center gap-4">
                        {currentUserRole === 'admin' && (
                            <button
                                onClick={toggleEmergency}
                                className={`px-6 py-3 rounded-xl font-bold border-2 transition-all shadow-xl flex items-center gap-2 ${emergencyActive
                                    ? 'bg-red-600 border-red-400 animate-pulse text-white'
                                    : 'bg-gray-800 border-gray-600 text-gray-400 hover:border-red-500 hover:text-red-400'
                                    }`}
                            >
                                {emergencyActive ? '🛑 EMERGENCY STOP ACTIVE' : '🚨 Emergency Stop'}
                            </button>
                        )}
                        <button
                            onClick={() => setCurrentUserRole(null)}
                            className="px-4 py-3 bg-gray-800 border border-gray-600 text-gray-400 hover:text-white rounded-xl transition-colors text-sm"
                        >
                            Logout ({currentUserRole})
                        </button>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex justify-center mb-8">
                    <div className="bg-gray-800 p-1 rounded-xl inline-flex space-x-1 overflow-x-auto max-w-full">
                        {(currentUserRole === 'admin' ? [
                            { id: 'create', label: 'Factory' },
                            { id: 'tools', label: 'Tools' },
                            { id: 'test', label: 'Test Flight' },
                            { id: 'govern', label: 'Governance' },
                            { id: 'observe', label: 'Observability' },
                            { id: 'analytics', label: '📊 Analytics' }
                        ] : [
                            { id: 'test', label: 'Test Flight' }
                        ]).map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id
                                    ? 'bg-purple-600 text-white shadow-lg'
                                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                                    }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Alerts */}
                {successMessage && (
                    <div onClick={() => setSuccessMessage('')} className="mb-6 p-4 bg-green-900/50 border border-green-500 rounded-xl text-green-300 cursor-pointer text-center">
                        {successMessage}
                    </div>
                )}
                {errorMessage && (
                    <div onClick={() => setErrorMessage('')} className="mb-6 p-4 bg-red-900/50 border border-red-500 rounded-xl text-red-300 cursor-pointer text-center">
                        {errorMessage}
                    </div>
                )}

                {/* ── TAB: TOOLS ────────────────────────────────────────── */}
                {activeTab === 'tools' && (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
                        {/* List of Existing Tools */}
                        <div className="lg:col-span-1 space-y-4">
                            <h2 className="text-xl font-semibold mb-4 text-gray-300">Registered Tools</h2>
                            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
                                {tools.map(tool => (
                                    <div key={tool.id} className="p-4 bg-gray-800/80 border border-gray-700 rounded-xl">
                                        <p className="font-bold text-lg text-white">{tool.name}</p>
                                        <p className="text-sm text-gray-400 mt-1">{tool.description}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Form */}
                        <form onSubmit={handleToolSubmit} className="lg:col-span-2 bg-gray-800/50 backdrop-blur-xl border border-gray-700 rounded-2xl shadow-2xl p-8 space-y-6 h-fit">
                            <h2 className="text-2xl font-bold mb-4">Create Custom Tool</h2>
                            <p className="text-gray-400 text-sm mb-4">Register a new tool for agents to use. Provide the OpenAPI/JSON schema for parameters.</p>

                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Function Name</label>
                                <input value={toolFormData.name} onChange={e => setToolFormData({ ...toolFormData, name: e.target.value })} required className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none font-mono text-sm" placeholder="e.g. get_weather" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Description (for the LLM)</label>
                                <input value={toolFormData.description} onChange={e => setToolFormData({ ...toolFormData, description: e.target.value })} required className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" placeholder="Get the current weather for a location" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Parameters Schema (JSON)</label>
                                <textarea value={toolFormData.parameters} onChange={e => setToolFormData({ ...toolFormData, parameters: e.target.value })} required rows={8} className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none font-mono text-xs whitespace-pre" placeholder={`{\n  "type": "OBJECT",\n  "properties": {\n    "location": { "type": "STRING", "description": "City name" }\n  },\n  "required": ["location"]\n}`} />
                            </div>

                            <button type="submit" disabled={submittingTool} className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 rounded-xl font-bold shadow-lg transition-all">
                                {submittingTool ? 'Registering...' : 'Register Tool'}
                            </button>
                        </form>
                    </div>
                )}

                {/* ── TAB: FACTORY (Create) ─────────────────────────── */}
                {activeTab === 'create' && (
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
                        {/* List of Existing Agents */}
                        <div className="lg:col-span-1 space-y-4">
                            <h2 className="text-xl font-semibold mb-4 text-gray-300">Existing Blueprints</h2>
                            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
                                {agents.map(agent => (
                                    <div key={agent.id} className={`p-4 bg-gray-800/80 border ${editingAgentId === agent.id ? 'border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.4)]' : 'border-gray-700'} rounded-xl transition-all group`}>
                                        <div className="flex justify-between items-start mb-2">
                                            <div>
                                                <p className="font-bold text-lg text-white">{agent.name || <span className="italic text-gray-500">Unnamed Agent</span>}</p>
                                                <p className="text-xs text-gray-400 font-mono">{agent.role || 'No role'}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${agent.isActive !== false ? 'bg-green-900/30 border-green-600 text-green-400' : 'bg-red-900/30 border-red-600 text-red-400'}`}>
                                                    {agent.isActive !== false ? '🟢 Active' : '🔴 Shutdown'}
                                                </span>
                                                {agent.currentVersion > 1 && <span className="text-[10px] text-gray-500 font-mono">v{agent.currentVersion}</span>}
                                            </div>
                                        </div>
                                        <p className="text-xs text-gray-500 mt-1">Budget: ${(agent.budgetUsd ?? 5.0).toFixed(2)}</p>
                                        <div className="flex gap-2 mt-3">
                                            <button type="button" onClick={() => handleEditClick(agent)} className="flex-1 py-1.5 bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700/50 text-blue-300 text-sm rounded-lg transition-colors">Edit</button>
                                            <button type="button" onClick={() => handleViewVersions(agent.id)} className="flex-1 py-1.5 bg-purple-900/40 hover:bg-purple-800/60 border border-purple-700/50 text-purple-300 text-sm rounded-lg transition-colors">📜 History</button>
                                            <button type="button" onClick={() => handleDeleteAgent(agent.id)} className="flex-1 py-1.5 bg-red-900/40 hover:bg-red-800/60 border border-red-700/50 text-red-300 text-sm rounded-lg transition-colors">Delete</button>
                                        </div>
                                        {agent.isActive === false && (
                                            <button type="button" onClick={() => handleReactivate(agent.id)} className="w-full mt-2 py-1.5 bg-green-900/40 hover:bg-green-800/60 border border-green-700/50 text-green-300 text-sm rounded-lg transition-colors">🔄 Reactivate Agent</button>
                                        )}
                                    </div>
                                ))}
                                <button type="button" onClick={() => { setEditingAgentId(null); setFormData({ name: '', role: '', goal: '', systemPrompt: '', tools: [], budgetUsd: 5.0 }); }} className="w-full py-4 border-2 border-dashed border-gray-600 hover:border-purple-500 rounded-xl text-gray-400 hover:text-purple-400 transition-colors font-medium">
                                    + Create New Blueprint
                                </button>
                            </div>
                        </div>

                        {/* Form */}
                        <form onSubmit={handleSubmit} className="lg:col-span-2 bg-gray-800/50 backdrop-blur-xl border border-gray-700 rounded-2xl shadow-2xl p-8 space-y-6 h-fit">
                            <h2 className="text-2xl font-bold mb-4">
                                {editingAgentId ? 'Edit Agent Blueprint' : 'Create New Agent Blueprint'}
                            </h2>

                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Name</label>
                                <input name="name" value={formData.name} onChange={handleInputChange} required className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" placeholder="Agent Name" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Role</label>
                                <input name="role" value={formData.role} onChange={handleInputChange} required className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" placeholder="e.g. Analyst" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">Goal</label>
                                <input name="goal" value={formData.goal} onChange={handleInputChange} required className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" placeholder="Primary Objective" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-1">System Prompt</label>
                                <textarea name="systemPrompt" value={formData.systemPrompt} onChange={handleInputChange} required rows={4} className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" placeholder="Instructions..." />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-300 mb-1">💰 Budget (USD)</label>
                                    <input type="number" step="0.01" min="0.01" value={formData.budgetUsd} onChange={e => setFormData({ ...formData, budgetUsd: parseFloat(e.target.value) || 5.0 })} className="w-full px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl focus:ring-2 focus:ring-purple-500 outline-none" />
                                </div>
                                <div className="flex items-end">
                                    <p className="text-xs text-gray-500 pb-3">Agent auto-shuts down when spend exceeds this limit.</p>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-300 mb-3">Tools</label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-40 overflow-y-auto p-2 border border-gray-700 rounded-xl bg-gray-900/30">
                                    {tools.map((tool) => (
                                        <label key={tool.id} className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border ${formData.tools.includes(tool.name) ? 'bg-purple-900/40 border-purple-500' : 'border-transparent hover:bg-gray-800'}`}>
                                            <input type="checkbox" checked={formData.tools.includes(tool.name)} onChange={() => handleToolToggle(tool.name)} className="accent-purple-500" />
                                            <span className="text-sm font-medium">{tool.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <button type="submit" disabled={submitting} className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 rounded-xl font-bold shadow-lg transition-all flex flex-col items-center justify-center">
                                <span>{submitting ? (editingAgentId ? 'Updating Agent...' : 'Deploying Agent...') : (editingAgentId ? 'Update Agent' : 'Deploy Agent')}</span>
                                {submitting && <span className="text-xs text-pink-200 mt-1 font-normal animate-pulse">Building ADK Engine (takes 3-5 mins)...</span>}
                            </button>
                        </form>

                        {/* Version History Modal */}
                        {versionHistoryAgentId && (
                            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                                <div className="bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                                    <div className="flex justify-between items-center p-6 border-b border-gray-700">
                                        <h3 className="text-xl font-bold">📜 Version History</h3>
                                        <button onClick={() => setVersionHistoryAgentId(null)} className="text-gray-400 hover:text-white text-2xl">&times;</button>
                                    </div>
                                    <div className="overflow-y-auto p-6 space-y-3 flex-1">
                                        {loadingVersions ? (
                                            <p className="text-gray-500 text-center py-8">Loading versions...</p>
                                        ) : versionHistory.length === 0 ? (
                                            <p className="text-gray-500 text-center py-8">No version history yet. Edit the agent to create the first snapshot.</p>
                                        ) : (
                                            versionHistory.map((v: any) => (
                                                <div key={v.id} className="p-4 bg-gray-900/60 border border-gray-700 rounded-xl">
                                                    <div className="flex justify-between items-center mb-2">
                                                        <div className="flex items-center gap-3">
                                                            <span className="px-2 py-0.5 bg-purple-900/50 border border-purple-600 text-purple-300 rounded-full text-xs font-bold">v{v.version}</span>
                                                            <span className="text-white font-medium">{v.name}</span>
                                                        </div>
                                                        <button onClick={() => handleRollback(v.agentId, v.version)} className="px-3 py-1 bg-yellow-900/40 hover:bg-yellow-800/60 border border-yellow-700/50 text-yellow-300 text-xs rounded-lg transition-colors">↩️ Restore</button>
                                                    </div>
                                                    <p className="text-xs text-gray-400">Role: {v.role} · Tools: {v.toolNames?.join(', ') || 'none'}</p>
                                                    <p className="text-xs text-gray-500 mt-1">Changed by: {v.changedBy} · {new Date(v.createdAt).toLocaleString()}</p>
                                                    <details className="mt-2">
                                                        <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">System Prompt</summary>
                                                        <p className="text-xs text-gray-400 mt-1 whitespace-pre-wrap bg-gray-800 p-2 rounded-lg">{v.systemPrompt}</p>
                                                    </details>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ── TAB: TEST FLIGHT ────────────────────────────────── */}
                {activeTab === 'test' && (
                    <div className="max-w-4xl mx-auto bg-gray-800/50 backdrop-blur-xl border border-gray-700 rounded-2xl shadow-2xl p-6 h-[600px] flex flex-col">
                        <div className="flex gap-4 mb-4">
                            <select value={selectedAgentId} onChange={(e) => { setSelectedAgentId(e.target.value); setChatHistory([]); }} className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl outline-none">
                                <option value="">Select an Agent...</option>
                                {agents.map(agent => (
                                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                                ))}
                            </select>
                            {selectedAgentId && (
                                <button onClick={handleClearChat} className="px-6 py-3 bg-red-900/50 hover:bg-red-800 border border-red-600 text-red-300 rounded-xl font-bold transition-colors whitespace-nowrap">
                                    Clear Chat
                                </button>
                            )}
                        </div>
                        <div className="flex-1 bg-gray-900/30 rounded-xl p-4 overflow-y-auto space-y-4 border border-gray-700 mb-4">
                            {chatHistory.map((msg, idx) => (
                                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] p-3 rounded-xl ${msg.role === 'user' ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
                                        <p className="text-xs opacity-50 mb-1">{msg.role.toUpperCase()}</p>
                                        <div className="whitespace-pre-wrap">{msg.content}</div>
                                    </div>
                                </div>
                            ))}
                            {/* Streaming Message Indicator */}
                            {chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user' && (
                                <div className="text-left w-full pl-2 fade-in">
                                    <div className="inline-block p-4 max-w-[85%] rounded-2xl bg-gray-800/80 border border-gray-700 shadow-xl overflow-hidden relative group">
                                        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent"></div>

                                        {/* The actual streamed text */}
                                        {streamingContent ? (
                                            <p className="text-sm whitespace-pre-wrap font-mono text-cyan-300 leading-relaxed tracking-wide">
                                                {streamingContent}
                                                <span className="inline-block w-2 h-4 ml-1 bg-cyan-400 animate-pulse"></span>
                                            </p>
                                        ) : (
                                            <div className="flex space-x-2 items-center h-5">
                                                <div className="w-2.5 h-2.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                                <div className="w-2.5 h-2.5 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                                <div className="w-2.5 h-2.5 bg-gray-400 rounded-full animate-bounce"></div>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-500 mt-2 flex items-center gap-1 font-mono tracking-wider">
                                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse"></span>
                                        Agent Generating...
                                    </p>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>
                        <form onSubmit={handleTestSend} className="flex gap-2">
                            <input type="text" value={testMessage} onChange={(e) => setTestMessage(e.target.value)} placeholder="Type a message..." className="flex-1 px-4 py-3 bg-gray-900/50 border border-gray-600 rounded-xl outline-none" disabled={!selectedAgentId} />
                            <button type="submit" disabled={!selectedAgentId} className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-xl font-bold">Send</button>
                        </form>
                    </div>
                )}

                {/* ── TAB: GOVERNANCE ─────────────────────────────────── */}
                {activeTab === 'govern' && (
                    <div className="max-w-6xl mx-auto space-y-8">
                        {/* ── SECTION 1: Pending Approvals with SLA Timer ──── */}
                        <div>
                            <h2 className="text-2xl font-bold mb-4">🔒 Pending Approvals (HITL)</h2>
                            <div className="grid gap-4">
                                {tasks.length === 0 ? (
                                    <p className="text-gray-500 text-center py-8 bg-gray-800/30 rounded-xl border border-gray-700/50">No pending tasks requiring approval.</p>
                                ) : (
                                    tasks.map(task => {
                                        const sla = getSlaInfo(task.createdAt);
                                        return (
                                            <div key={task.id} className="bg-gray-800/80 border border-gray-700 rounded-xl p-6">
                                                <div className="flex justify-between items-start">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                                                            <span className="bg-yellow-500/20 text-yellow-300 text-xs px-2 py-1 rounded-full border border-yellow-500/30">PENDING</span>
                                                            <span className={`text-xs px-2 py-1 rounded-full border font-mono ${sla.color}`}>⏱ {sla.display} ago</span>
                                                            <span className="text-gray-400 text-sm">{new Date(task.createdAt).toLocaleString()}</span>
                                                            <span className="text-purple-400 text-sm font-bold">@{task.agent?.name || 'System'}</span>
                                                        </div>
                                                        <p className="text-lg">{task.description}</p>
                                                    </div>
                                                    <div className="flex gap-3 ml-4">
                                                        <button onClick={() => handleEditTask(task)} className={`px-4 py-2 border rounded-lg transition-colors text-sm ${editingTaskId === task.id ? 'bg-blue-700 border-blue-500 text-white' : 'bg-blue-900/50 border-blue-600 text-blue-300 hover:bg-blue-800'}`}>
                                                            {editingTaskId === task.id ? 'Close Editor' : '✏️ Edit'}
                                                        </button>
                                                        <button onClick={() => handleVote(task.id, 'reject')} className="px-4 py-2 bg-red-900/50 border border-red-600 text-red-300 rounded-lg hover:bg-red-800 transition-colors">Reject</button>
                                                        <button onClick={() => handleVote(task.id, 'approve')} className="px-4 py-2 bg-green-900/50 border border-green-600 text-green-300 rounded-lg hover:bg-green-800 transition-colors">Approve</button>
                                                    </div>
                                                </div>

                                                {/* Expandable Payload Editor */}
                                                {editingTaskId === task.id && (
                                                    <div className="mt-4 p-4 bg-gray-900/60 border border-gray-600 rounded-xl space-y-3">
                                                        <div className="flex justify-between items-center">
                                                            <label className="text-sm font-medium text-gray-300">Input Payload (JSON)</label>
                                                            <span className="text-xs text-gray-500">Edit the payload before approving</span>
                                                        </div>
                                                        <textarea value={editingPayload} onChange={(e) => setEditingPayload(e.target.value)} rows={6} className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm text-green-300 whitespace-pre" />
                                                        <div className="flex gap-3">
                                                            <button onClick={() => handleSaveTaskEdit(task.id)} disabled={savingTask} className="px-6 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 rounded-lg font-bold text-white text-sm transition-all disabled:opacity-50">
                                                                {savingTask ? 'Saving...' : '💾 Save Edit'}
                                                            </button>
                                                            <button onClick={() => setEditingPayload(JSON.stringify(task.inputPayload || {}, null, 2))} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 text-gray-300 rounded-lg text-sm transition-colors">Reset</button>
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Comments Section */}
                                                <div className="mt-4 border-t border-gray-700/50 pt-3">
                                                    <button onClick={() => setCommentingTaskId(commentingTaskId === task.id ? null : task.id)} className="text-xs text-gray-400 hover:text-gray-200 transition-colors">
                                                        💬 {(task as any).comments?.length || 0} Notes {commentingTaskId === task.id ? '▲' : '▼'}
                                                    </button>
                                                    {commentingTaskId === task.id && (
                                                        <div className="mt-3 space-y-2">
                                                            {((task as any).comments || []).map((c: any, ci: number) => (
                                                                <div key={ci} className="text-sm bg-gray-900/40 p-3 rounded-lg border border-gray-700/30">
                                                                    <span className="text-purple-400 font-medium">{c.author}</span>
                                                                    <span className="text-gray-500 text-xs ml-2">{new Date(c.timestamp).toLocaleString()}</span>
                                                                    <p className="text-gray-300 mt-1">{c.text}</p>
                                                                </div>
                                                            ))}
                                                            <div className="flex gap-2 mt-2">
                                                                <input value={commentText} onChange={e => setCommentText(e.target.value)} placeholder="Add a note..." className="flex-1 px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm outline-none focus:ring-1 focus:ring-purple-500" onKeyDown={e => e.key === 'Enter' && handleAddComment(task.id)} />
                                                                <button onClick={() => handleAddComment(task.id)} className="px-4 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded-lg transition-colors">Add</button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>

                        {/* ── SECTION 2: Task History with Filters ──────── */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">📋 Task History</h3>
                            {/* Filter Bar */}
                            <div className="flex flex-wrap gap-3 mb-4">
                                <select value={taskStatusFilter} onChange={e => { setTaskStatusFilter(e.target.value); setTimeout(fetchAllTasks, 50); }} className="px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm outline-none">
                                    <option value="ALL">All Statuses</option>
                                    <option value="PENDING">Pending</option>
                                    <option value="APPROVED">Approved</option>
                                    <option value="COMPLETED">Completed</option>
                                    <option value="REJECTED">Rejected</option>
                                </select>
                                <select value={taskAgentFilter} onChange={e => { setTaskAgentFilter(e.target.value); setTimeout(fetchAllTasks, 50); }} className="px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm outline-none">
                                    <option value="">All Agents</option>
                                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                                <input value={taskSearchQuery} onChange={e => setTaskSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchAllTasks()} placeholder="🔍 Search tasks..." className="flex-1 min-w-[200px] px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm outline-none" />
                                <button onClick={fetchAllTasks} className="px-4 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded-lg transition-colors">Search</button>
                            </div>
                            {/* Task List */}
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm text-gray-400">
                                    <thead className="bg-gray-900/50 uppercase font-medium text-xs">
                                        <tr>
                                            <th className="px-4 py-3">Status</th>
                                            <th className="px-4 py-3">Description</th>
                                            <th className="px-4 py-3">Agent</th>
                                            <th className="px-4 py-3">Actioned By</th>
                                            <th className="px-4 py-3">Created</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {allTasks.length === 0 && (
                                            <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No tasks match your filters.</td></tr>
                                        )}
                                        {allTasks.map((t: any) => {
                                            const statusColors: any = { PENDING: 'bg-yellow-900/30 border-yellow-500 text-yellow-400', APPROVED: 'bg-blue-900/30 border-blue-500 text-blue-400', COMPLETED: 'bg-green-900/30 border-green-500 text-green-400', REJECTED: 'bg-red-900/30 border-red-500 text-red-400' };
                                            return (
                                                <tr key={t.id} className="hover:bg-gray-700/30">
                                                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs border ${statusColors[t.status] || 'text-gray-400 border-gray-600'}`}>{t.status}</span></td>
                                                    <td className="px-4 py-3 text-white max-w-[300px] truncate">{t.description}</td>
                                                    <td className="px-4 py-3 text-purple-400">{t.agent?.name || '—'}</td>
                                                    <td className="px-4 py-3">{t.actionedBy || '—'}</td>
                                                    <td className="px-4 py-3 text-xs">{new Date(t.createdAt).toLocaleString()}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* ── SECTION 3: Audit Log ─────────────────────── */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">📜 Audit Log</h3>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm text-gray-400">
                                    <thead className="bg-gray-900/50 uppercase font-medium text-xs">
                                        <tr>
                                            <th className="px-4 py-3">Action</th>
                                            <th className="px-4 py-3">Entity</th>
                                            <th className="px-4 py-3">Performed By</th>
                                            <th className="px-4 py-3">Details</th>
                                            <th className="px-4 py-3">Time</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {auditLogs.length === 0 && (
                                            <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No audit entries yet. Approve or reject a task to generate entries.</td></tr>
                                        )}
                                        {auditLogs.map((log: any) => {
                                            const actionColors: any = { APPROVE: 'text-green-400', REJECT: 'text-red-400', EDIT: 'text-blue-400', COMMENT: 'text-purple-400' };
                                            return (
                                                <tr key={log.id} className="hover:bg-gray-700/30">
                                                    <td className={`px-4 py-3 font-bold ${actionColors[log.action] || 'text-gray-400'}`}>{log.action}</td>
                                                    <td className="px-4 py-3"><span className="text-xs font-mono text-gray-500">{log.entityType}</span> <span className="text-xs text-gray-600">{log.entityId.substring(0, 8)}...</span></td>
                                                    <td className="px-4 py-3 text-white">{log.performedBy}</td>
                                                    <td className="px-4 py-3 text-xs max-w-[250px] truncate">{log.details ? (log.details.description || log.details.comment?.text || JSON.stringify(log.details).substring(0, 60)) : '—'}</td>
                                                    <td className="px-4 py-3 text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── TAB: OBSERVABILITY ──────────────────────────────── */}
                {activeTab === 'observe' && stats && (
                    <div className="max-w-6xl mx-auto space-y-8">
                        {/* KPI Cards */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                            <div className="bg-gray-800/50 border border-gray-700 p-6 rounded-2xl">
                                <h3 className="text-gray-400 text-sm font-medium">Total Cost (Est.)</h3>
                                <p className="text-4xl font-bold text-green-400 mt-2">
                                    {(() => {
                                        const tc = stats.perAgentCosts?.reduce((s: number, a: any) => s + (a.totalCost || 0), 0) || stats.totalCost || 0;
                                        if (tc === 0) return '$0.00';
                                        if (tc >= 1) return `$${tc.toFixed(2)}`;
                                        if (tc >= 0.01) return `$${tc.toFixed(4)}`;
                                        return `$${tc.toFixed(6)}`;
                                    })()}
                                </p>
                            </div>
                            <div className="bg-gray-800/50 border border-gray-700 p-6 rounded-2xl">
                                <h3 className="text-gray-400 text-sm font-medium">Active Agents</h3>
                                <p className="text-4xl font-bold text-blue-400 mt-2">{stats.activeAgents}</p>
                            </div>
                            <div className="bg-gray-800/50 border border-gray-700 p-6 rounded-2xl">
                                <h3 className="text-gray-400 text-sm font-medium">Pending Tasks</h3>
                                <p className="text-4xl font-bold text-yellow-400 mt-2">{stats.pendingTasks}</p>
                            </div>
                            <div className="bg-gray-800/50 border border-gray-700 p-6 rounded-2xl">
                                <h3 className="text-gray-400 text-sm font-medium">🧟 Zombie Tasks</h3>
                                <p className={`text-4xl font-bold mt-2 ${(stats.zombieCount || 0) > 0 ? 'text-red-400' : 'text-gray-500'}`}>{stats.zombieCount || 0}</p>
                            </div>
                        </div>

                        {/* Trace Map */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">Live Trace Map</h3>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm text-gray-400">
                                    <thead className="bg-gray-900/50 uppercase font-medium text-xs">
                                        <tr>
                                            <th className="px-4 py-3">Time</th>
                                            <th className="px-4 py-3">Service</th>
                                            <th className="px-4 py-3">Operation</th>
                                            <th className="px-4 py-3">Status</th>
                                            <th className="px-4 py-3">Duration</th>
                                            <th className="px-4 py-3">Trace ID</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {stats.traces.length === 0 && (
                                            <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No traces yet. Send a webhook via the Ingress Gateway to generate traces.</td></tr>
                                        )}
                                        {stats.traces.map((trace: any) => (
                                            <React.Fragment key={trace.id}>
                                                <tr className="hover:bg-gray-700/30 cursor-pointer" onClick={() => { if (expandedTraceId === trace.traceId) { setExpandedTraceId(null); setTraceSpans([]); } else { setExpandedTraceId(trace.traceId); fetchTraceSpans(trace.traceId); } }}>
                                                    <td className="px-4 py-3">{new Date(trace.startedAt).toLocaleTimeString()}</td>
                                                    <td className="px-4 py-3 text-white">{trace.service}</td>
                                                    <td className="px-4 py-3">{trace.operation}</td>
                                                    <td className="px-4 py-3">
                                                        <span className={`px-2 py-1 rounded-full text-xs border ${trace.status === 'OK' ? 'bg-green-900/30 border-green-500 text-green-400' : 'bg-red-900/30 border-red-500 text-red-400'}`}>
                                                            {trace.status}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">{trace.durationMs}ms</td>
                                                    <td className="px-4 py-3 font-mono text-xs opacity-50">{trace.traceId.substring(0, 8)}... {expandedTraceId === trace.traceId ? '▲' : '▼'}</td>
                                                </tr>
                                                {/* Expanded Span Viewer */}
                                                {expandedTraceId === trace.traceId && (
                                                    <tr>
                                                        <td colSpan={6} className="p-0">
                                                            <div className="bg-gray-900/70 px-6 py-4 border-t border-b border-purple-500/20">
                                                                <p className="text-xs text-purple-400 font-medium mb-3">Span Waterfall — {traceSpans.length} span(s)</p>
                                                                {traceSpans.length === 0 ? (
                                                                    <p className="text-xs text-gray-500">No spans recorded for this trace.</p>
                                                                ) : (
                                                                    <div className="space-y-1">
                                                                        {traceSpans.map((span: any, si: number) => {
                                                                            const maxDur = Math.max(...traceSpans.map((s: any) => s.durationMs || 1), 1);
                                                                            const widthPct = Math.max(((span.durationMs || 1) / maxDur) * 100, 3);
                                                                            return (
                                                                                <div key={span.id} className="flex items-center gap-3 text-xs" style={{ paddingLeft: `${(si > 0 && span.parentId ? 24 : 0)}px` }}>
                                                                                    <span className="w-24 text-gray-500 shrink-0">{span.service}</span>
                                                                                    <span className="w-36 text-gray-400 truncate shrink-0">{span.operation}</span>
                                                                                    <div className="flex-1 bg-gray-800 rounded overflow-hidden h-5 relative">
                                                                                        <div className={`h-full rounded ${span.status === 'OK' ? 'bg-gradient-to-r from-purple-600 to-cyan-500' : 'bg-gradient-to-r from-red-600 to-red-400'}`} style={{ width: `${widthPct}%` }}></div>
                                                                                        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-white font-mono">{span.durationMs}ms</span>
                                                                                    </div>
                                                                                    <span className={`w-12 text-center ${span.status === 'OK' ? 'text-green-500' : 'text-red-400'}`}>{span.status}</span>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Per-Agent Cost Breakdown */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">💰 Per-Agent Cost Breakdown</h3>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm text-gray-400">
                                    <thead className="bg-gray-900/50 uppercase font-medium text-xs">
                                        <tr>
                                            <th className="px-4 py-3">Agent</th>
                                            <th className="px-4 py-3">Budget</th>
                                            <th className="px-4 py-3">Status</th>
                                            <th className="px-4 py-3">Invocations</th>
                                            <th className="px-4 py-3">Tokens</th>
                                            <th className="px-4 py-3">Cost (USD)</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {(!stats.perAgentCosts || stats.perAgentCosts.length === 0) && (
                                            <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No usage recorded yet. Chat with an agent to generate cost data.</td></tr>
                                        )}
                                        {stats.perAgentCosts?.map((ac: any) => {
                                            const agentData = agents.find((a: any) => a.id === ac.agentId);
                                            const budget = agentData?.budgetUsd ?? 5.0;
                                            const isActive = agentData?.isActive !== false;
                                            const costPercent = budget > 0 ? (ac.totalCost / budget) * 100 : 0;
                                            return (
                                                <tr key={ac.agentId} className="hover:bg-gray-700/30">
                                                    <td className="px-4 py-3 text-white font-medium">{ac.agentName}</td>
                                                    <td className="px-4 py-3">
                                                        <span className="font-mono">${budget.toFixed(2)}</span>
                                                        {costPercent > 80 && <span className="ml-1 text-[10px] text-yellow-400">⚠️ {costPercent.toFixed(0)}%</span>}
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {isActive ? (
                                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-900/30 border border-green-600 text-green-400">Active</span>
                                                        ) : (
                                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-900/30 border border-red-600 text-red-400">Shutdown</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3">{ac.invocations}</td>
                                                    <td className="px-4 py-3">{ac.totalTokens.toLocaleString()}</td>
                                                    <td className="px-4 py-3 text-green-400 font-mono">${ac.totalCost.toFixed(6)}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Reconciliation Report */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">📊 Reconciliation Report</h3>
                            {reconciliation ? (
                                <div className="space-y-4">
                                    <p className="text-gray-500 text-xs">Generated: {new Date(reconciliation.generatedAt).toLocaleString()}</p>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                        <div className="bg-gray-900/60 p-4 rounded-xl text-center">
                                            <p className="text-purple-400 text-2xl font-bold">{reconciliation.summary?.totalIngressEvents ?? 0}</p>
                                            <p className="text-gray-400 text-xs mt-1">Total Ingress</p>
                                        </div>
                                        <div className="bg-gray-900/60 p-4 rounded-xl text-center">
                                            <p className="text-green-400 text-2xl font-bold">{reconciliation.summary?.totalResponses ?? 0}</p>
                                            <p className="text-gray-400 text-xs mt-1">Total Responses</p>
                                        </div>
                                        <div className="bg-gray-900/60 p-4 rounded-xl text-center">
                                            <p className="text-yellow-400 text-2xl font-bold">{reconciliation.summary?.totalTasksCreated ?? 0}</p>
                                            <p className="text-gray-400 text-xs mt-1">HITL Tasks</p>
                                        </div>
                                        <div className="bg-gray-900/60 p-4 rounded-xl text-center">
                                            <p className={`text-2xl font-bold ${(reconciliation.summary?.unresolvedCount ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>{reconciliation.summary?.unresolvedCount ?? 0}</p>
                                            <p className="text-gray-400 text-xs mt-1">Unresolved</p>
                                        </div>
                                    </div>
                                    {reconciliation.taskBreakdown && (
                                        <div className="mt-4 text-sm text-gray-400">
                                            <p>Task Breakdown: <span className="text-yellow-400">{reconciliation.taskBreakdown.pending} Pending</span> · <span className="text-green-400">{reconciliation.taskBreakdown.approved} Approved</span> · <span className="text-blue-400">{reconciliation.taskBreakdown.completed} Completed</span> · <span className="text-red-400">{reconciliation.taskBreakdown.rejected} Rejected</span></p>
                                        </div>
                                    )}
                                    {reconciliation.costSummary && (
                                        <div className="mt-2 text-sm text-gray-400">
                                            <p>Total Tokens: <span className="text-white">{(reconciliation.costSummary.totalTokens || 0).toLocaleString()}</span> · Total Cost: <span className="text-green-400">{(() => {
                                                const tc = reconciliation.costSummary.totalCostUsd || reconciliation.costSummary.totalCost || 0;
                                                if (tc === 0) return '$0.00';
                                                if (tc >= 1) return `$${tc.toFixed(2)}`;
                                                if (tc >= 0.01) return `$${tc.toFixed(4)}`;
                                                return `$${tc.toFixed(6)}`;
                                            })()}</span></p>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <p className="text-gray-500">Loading reconciliation data...</p>
                            )}
                        </div>

                        {/* ── Error Log Feed ──────────────────────────── */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">🔴 Error Log Feed</h3>
                            <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                                <table className="w-full text-left text-sm text-gray-400">
                                    <thead className="bg-gray-900/50 uppercase font-medium text-xs sticky top-0">
                                        <tr>
                                            <th className="px-4 py-3">Time</th>
                                            <th className="px-4 py-3">Service</th>
                                            <th className="px-4 py-3">Operation</th>
                                            <th className="px-4 py-3">Message</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-700">
                                        {errorLogs.length === 0 && (
                                            <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No errors recorded. This is a good thing! 🎉</td></tr>
                                        )}
                                        {errorLogs.map((err: any) => (
                                            <tr key={err.id} className="hover:bg-red-900/10">
                                                <td className="px-4 py-3 text-xs whitespace-nowrap">{new Date(err.createdAt).toLocaleString()}</td>
                                                <td className="px-4 py-3 text-white">{err.service}</td>
                                                <td className="px-4 py-3">{err.operation}</td>
                                                <td className="px-4 py-3 text-red-400 max-w-[400px] truncate font-mono text-xs">{err.message}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* ── Agent Activity Timeline ─────────────────── */}
                        <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-6">
                            <h3 className="text-xl font-bold mb-4">📅 Agent Activity Timeline</h3>
                            <div className="flex gap-3 mb-4">
                                <select value={activityAgentId} onChange={e => { setActivityAgentId(e.target.value); if (e.target.value) fetchAgentActivity(e.target.value); else setActivityTimeline([]); }} className="px-3 py-2 bg-gray-900/50 border border-gray-600 rounded-lg text-sm outline-none">
                                    <option value="">Select an agent...</option>
                                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                                </select>
                            </div>
                            {activityAgentId && activityTimeline.length === 0 && (
                                <p className="text-gray-500 text-center py-6">No activity recorded for this agent yet.</p>
                            )}
                            {activityTimeline.length > 0 && (
                                <div className="relative border-l-2 border-gray-700 ml-4 space-y-4 max-h-[400px] overflow-y-auto">
                                    {activityTimeline.map((event: any) => {
                                        const icons: any = { message: '💬', task: '🔒', usage: '⚡' };
                                        const colors: any = { message: 'border-blue-500', task: 'border-yellow-500', usage: 'border-purple-500' };
                                        return (
                                            <div key={event.id} className="relative pl-8">
                                                <span className={`absolute -left-[9px] w-4 h-4 rounded-full bg-gray-900 border-2 ${colors[event.type] || 'border-gray-500'} top-1`}></span>
                                                <div className={`bg-gray-900/40 p-3 rounded-lg border border-gray-700/30 ${event.type === 'message' ? 'cursor-pointer hover:border-gray-600' : ''}`}
                                                    onClick={() => { if (event.type === 'message') { if (expandedMessageId === event.id) { setExpandedMessageId(null); setMessageDetail(null); } else { setExpandedMessageId(event.id); fetchMessageDetail(event.id); } } }}>
                                                    <div className="flex items-center gap-2 text-xs">
                                                        <span>{icons[event.type] || '•'}</span>
                                                        <span className="text-gray-400">{new Date(event.timestamp).toLocaleString()}</span>
                                                        <span className="text-gray-600">|</span>
                                                        {event.type === 'message' && <span className={`${event.data.role === 'user' ? 'text-cyan-400' : 'text-green-400'}`}>{event.data.role}</span>}
                                                        {event.type === 'task' && <span className="text-yellow-400">{event.data.status}</span>}
                                                        {event.type === 'usage' && <span className="text-purple-400">{event.data.action}</span>}
                                                    </div>
                                                    <p className="text-sm text-gray-300 mt-1 truncate">
                                                        {event.type === 'message' && (event.data.content?.substring(0, 120) + (event.data.content?.length > 120 ? '...' : ''))}
                                                        {event.type === 'task' && event.data.description}
                                                        {event.type === 'usage' && `${event.data.tokens} tokens · $${event.data.costUsd?.toFixed(6) || '0'}`}
                                                    </p>
                                                    {/* Request/Response Inspector */}
                                                    {event.type === 'message' && expandedMessageId === event.id && messageDetail && (
                                                        <div className="mt-3 p-3 bg-gray-800/80 rounded-lg border border-gray-600/30 space-y-2">
                                                            <p className="text-xs text-purple-400 font-medium">📋 Message Inspector</p>
                                                            <div className="grid grid-cols-3 gap-2 text-xs">
                                                                <div><span className="text-gray-500">Role:</span> <span className="text-white">{messageDetail.role}</span></div>
                                                                <div><span className="text-gray-500">Tokens:</span> <span className="text-white">{messageDetail.tokens}</span></div>
                                                                <div><span className="text-gray-500">Cost:</span> <span className="text-green-400">${messageDetail.cost?.toFixed(6) || '0'}</span></div>
                                                            </div>
                                                            <pre className="text-xs text-green-300 bg-gray-900 p-3 rounded-lg overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap font-mono">{messageDetail.content}</pre>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ── TAB: ANALYTICS ────────────────────────────────────── */}
                {activeTab === 'analytics' && (() => {
                    const CHART_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#10b981', '#f97316', '#ef4444', '#3b82f6'];
                    const totalCost30d = agentTotals.reduce((s, a) => s + a.totalCost, 0);
                    const totalTokens30d = agentTotals.reduce((s, a) => s + a.totalTokens, 0);
                    const avgCostPerToken = totalTokens30d > 0 ? totalCost30d / totalTokens30d : 0;

                    // Smart cost formatter — adapts precision to value magnitude
                    const formatCost = (v: number) => {
                        if (v === 0) return '$0';
                        if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
                        if (Math.abs(v) >= 0.01) return `$${v.toFixed(4)}`;
                        return `$${v.toFixed(6)}`;
                    };

                    // Pie chart data for cost distribution
                    const pieData = agentTotals.filter(a => a.totalCost > 0).map(a => ({
                        name: a.agentName,
                        value: a.totalCost,
                    }));

                    return (
                        <div className="max-w-6xl mx-auto space-y-8">
                            {/* Header */}
                            <div className="flex justify-between items-center">
                                <div>
                                    <h2 className="text-3xl font-bold bg-gradient-to-r from-purple-400 via-cyan-400 to-pink-400 bg-clip-text text-transparent">Cost & Usage Analytics</h2>
                                    <p className="text-gray-500 text-sm mt-1">Real-time cost tracking across all agents — last 30 days</p>
                                </div>
                                <button onClick={fetchCostTimeseries} className="px-5 py-2.5 bg-gray-800/80 hover:bg-gray-700 border border-gray-600 hover:border-purple-500/50 text-gray-300 hover:text-white rounded-xl text-sm transition-all flex items-center gap-2 group">
                                    <span className="group-hover:rotate-180 transition-transform duration-500">🔄</span> Refresh
                                </button>
                            </div>

                            {/* ── KPI Summary Cards ─────────────────────────── */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                                {/* Card 1: Total Cost */}
                                <div className="relative overflow-hidden bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur-xl border border-gray-700/50 p-6 rounded-2xl group hover:border-green-500/30 transition-all duration-300">
                                    <div className="absolute top-0 right-0 w-24 h-24 bg-green-500/5 rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-green-500/10 transition-colors" />
                                    <div className="relative">
                                        <div className="flex items-center gap-2 mb-3">
                                            <span className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center text-sm">💰</span>
                                            <h3 className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Total Spend</h3>
                                        </div>
                                        <p className="text-3xl font-bold text-green-400 font-mono">{formatCost(totalCost30d)}</p>
                                        <p className="text-[10px] text-gray-500 mt-2 font-mono">Last 30 days</p>
                                    </div>
                                </div>

                                {/* Card 2: Total Tokens */}
                                <div className="relative overflow-hidden bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur-xl border border-gray-700/50 p-6 rounded-2xl group hover:border-purple-500/30 transition-all duration-300">
                                    <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-purple-500/10 transition-colors" />
                                    <div className="relative">
                                        <div className="flex items-center gap-2 mb-3">
                                            <span className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-sm">⚡</span>
                                            <h3 className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Total Tokens</h3>
                                        </div>
                                        <p className="text-3xl font-bold text-purple-400 font-mono">{totalTokens30d.toLocaleString()}</p>
                                        <p className="text-[10px] text-gray-500 mt-2 font-mono">across {agentTotals.length} agent{agentTotals.length !== 1 ? 's' : ''}</p>
                                    </div>
                                </div>

                                {/* Card 3: Avg Cost per Token */}
                                <div className="relative overflow-hidden bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur-xl border border-gray-700/50 p-6 rounded-2xl group hover:border-cyan-500/30 transition-all duration-300">
                                    <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-cyan-500/10 transition-colors" />
                                    <div className="relative">
                                        <div className="flex items-center gap-2 mb-3">
                                            <span className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-sm">📐</span>
                                            <h3 className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Avg Cost / Token</h3>
                                        </div>
                                        <p className="text-3xl font-bold text-cyan-400 font-mono">{avgCostPerToken > 0 ? `$${avgCostPerToken.toExponential(2)}` : '—'}</p>
                                        <p className="text-[10px] text-gray-500 mt-2 font-mono">efficiency metric</p>
                                    </div>
                                </div>

                                {/* Card 4: Agents Tracked */}
                                <div className="relative overflow-hidden bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur-xl border border-gray-700/50 p-6 rounded-2xl group hover:border-pink-500/30 transition-all duration-300">
                                    <div className="absolute top-0 right-0 w-24 h-24 bg-pink-500/5 rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-pink-500/10 transition-colors" />
                                    <div className="relative">
                                        <div className="flex items-center gap-2 mb-3">
                                            <span className="w-8 h-8 rounded-lg bg-pink-500/10 border border-pink-500/20 flex items-center justify-center text-sm">🤖</span>
                                            <h3 className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Agents Tracked</h3>
                                        </div>
                                        <p className="text-3xl font-bold text-pink-400 font-mono">{agentTotals.length}</p>
                                        <p className="text-[10px] text-gray-500 mt-2 font-mono">active in window</p>
                                    </div>
                                </div>
                            </div>

                            {/* ── Cost Over Time — Area Chart ─────────────── */}
                            <div className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-6 hover:border-purple-500/20 transition-all duration-500">
                                <div className="flex items-center gap-3 mb-2">
                                    <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/20 flex items-center justify-center">📈</span>
                                    <div>
                                        <h3 className="text-xl font-bold text-white">Daily Cost Trend</h3>
                                        <p className="text-gray-500 text-xs">Per-agent spend aggregated by day</p>
                                    </div>
                                </div>
                                {costTimeseries.length === 0 ? (
                                    <div className="text-center py-20 text-gray-500">
                                        <div className="text-5xl mb-4 opacity-30">📉</div>
                                        <p className="text-sm">No usage data yet. Chat with an agent in <span className="text-purple-400">Test Flight</span> to generate data.</p>
                                    </div>
                                ) : (
                                    <ResponsiveContainer width="100%" height={350}>
                                        <AreaChart data={(() => {
                                            const dateMap = new Map<string, any>();
                                            for (const entry of costTimeseries) {
                                                if (!dateMap.has(entry.date)) dateMap.set(entry.date, { date: entry.date });
                                                const row = dateMap.get(entry.date);
                                                row[entry.agentName] = (row[entry.agentName] || 0) + entry.totalCost;
                                            }
                                            return Array.from(dateMap.values());
                                        })()}>
                                            <defs>
                                                {CHART_COLORS.map((color, i) => (
                                                    <linearGradient key={`areaGrad${i}`} id={`areaGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                                                        <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                                                    </linearGradient>
                                                ))}
                                            </defs>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                                            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} axisLine={{ stroke: '#374151' }} />
                                            <YAxis stroke="#6b7280" tick={{ fontSize: 11 }} tickFormatter={formatCost} axisLine={{ stroke: '#374151' }} />
                                            <Tooltip
                                                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '16px', color: '#fff', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
                                                labelStyle={{ color: '#9ca3af', fontWeight: 600, marginBottom: 4 }}
                                                formatter={(value: any, name?: string) => [formatCost(Number(value)), name || '']}
                                            />
                                            <Legend wrapperStyle={{ paddingTop: 16 }} />
                                            {agentTotals.map((agent, idx) => (
                                                <Area
                                                    key={agent.agentId}
                                                    type="monotone"
                                                    dataKey={agent.agentName}
                                                    stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                                                    strokeWidth={2}
                                                    fillOpacity={1}
                                                    fill={`url(#areaGrad${idx % CHART_COLORS.length})`}
                                                    dot={false}
                                                    activeDot={{ r: 5, strokeWidth: 2, stroke: '#111827' }}
                                                />
                                            ))}
                                        </AreaChart>
                                    </ResponsiveContainer>
                                )}
                            </div>

                            {/* ── Charts Grid: Token Bar + Cost Pie ────────── */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                {/* Token Distribution — Bar Chart (FIXED: tokens only, no cost mixing) */}
                                <div className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-6 hover:border-purple-500/20 transition-all duration-500">
                                    <div className="flex items-center gap-3 mb-4">
                                        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/20 flex items-center justify-center">⚡</span>
                                        <div>
                                            <h3 className="text-lg font-bold text-white">Token Usage by Agent</h3>
                                            <p className="text-gray-500 text-xs">Total tokens consumed per agent</p>
                                        </div>
                                    </div>
                                    {agentTotals.length === 0 ? (
                                        <div className="text-center py-16 text-gray-500 text-sm">No data yet</div>
                                    ) : (
                                        <ResponsiveContainer width="100%" height={Math.max(200, agentTotals.length * 60)}>
                                            <BarChart data={agentTotals} layout="vertical" margin={{ left: 10, right: 30 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                                                <XAxis type="number" stroke="#6b7280" tick={{ fontSize: 11 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)} />
                                                <YAxis dataKey="agentName" type="category" stroke="#6b7280" tick={{ fontSize: 12, fill: '#d1d5db' }} width={110} />
                                                <Tooltip
                                                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '16px', color: '#fff', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
                                                    formatter={(value: any) => [Number(value).toLocaleString(), 'Tokens']}
                                                    cursor={{ fill: 'rgba(139, 92, 246, 0.08)' }}
                                                />
                                                <Bar dataKey="totalTokens" radius={[0, 8, 8, 0]} barSize={24}>
                                                    {agentTotals.map((_entry, idx) => (
                                                        <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} fillOpacity={0.85} />
                                                    ))}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    )}
                                </div>

                                {/* Cost Distribution — Pie Chart */}
                                <div className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-6 hover:border-cyan-500/20 transition-all duration-500">
                                    <div className="flex items-center gap-3 mb-4">
                                        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-green-500/20 border border-cyan-500/20 flex items-center justify-center">🍩</span>
                                        <div>
                                            <h3 className="text-lg font-bold text-white">Cost Distribution</h3>
                                            <p className="text-gray-500 text-xs">Proportional spend across agents</p>
                                        </div>
                                    </div>
                                    {pieData.length === 0 ? (
                                        <div className="text-center py-16 text-gray-500 text-sm">No cost data yet</div>
                                    ) : (
                                        <div className="flex flex-col items-center">
                                            <ResponsiveContainer width="100%" height={250}>
                                                <PieChart>
                                                    <Pie
                                                        data={pieData}
                                                        cx="50%"
                                                        cy="50%"
                                                        innerRadius={60}
                                                        outerRadius={100}
                                                        paddingAngle={3}
                                                        dataKey="value"
                                                        stroke="#111827"
                                                        strokeWidth={2}
                                                    >
                                                        {pieData.map((_entry, idx) => (
                                                            <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                                                        ))}
                                                    </Pie>
                                                    <Tooltip
                                                        contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '16px', color: '#fff', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
                                                        formatter={(value: any, name?: string) => [formatCost(Number(value)), name || '']}
                                                    />
                                                </PieChart>
                                            </ResponsiveContainer>
                                            {/* Pie Legend */}
                                            <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 mt-2">
                                                {pieData.map((entry, idx) => (
                                                    <div key={idx} className="flex items-center gap-2 text-xs">
                                                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                                                        <span className="text-gray-400">{entry.name}</span>
                                                        <span className="text-gray-500 font-mono">{formatCost(entry.value)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* ── Per-Agent Cost Table ────────────────────── */}
                            <div className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 backdrop-blur-xl border border-gray-700/50 rounded-2xl p-6 hover:border-green-500/20 transition-all duration-500">
                                <div className="flex items-center gap-3 mb-4">
                                    <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500/20 to-emerald-500/20 border border-green-500/20 flex items-center justify-center">📋</span>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">Agent Cost Breakdown</h3>
                                        <p className="text-gray-500 text-xs">Detailed per-agent spend, tokens, and cost-per-token</p>
                                    </div>
                                </div>
                                {agentTotals.length === 0 ? (
                                    <div className="text-center py-10 text-gray-500 text-sm">No data yet</div>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                            <thead>
                                                <tr className="border-b border-gray-700/50">
                                                    <th className="px-4 py-3 text-gray-400 font-semibold text-xs uppercase tracking-wider">Agent</th>
                                                    <th className="px-4 py-3 text-gray-400 font-semibold text-xs uppercase tracking-wider text-right">Tokens</th>
                                                    <th className="px-4 py-3 text-gray-400 font-semibold text-xs uppercase tracking-wider text-right">Cost (USD)</th>
                                                    <th className="px-4 py-3 text-gray-400 font-semibold text-xs uppercase tracking-wider text-right">Cost/1k Tokens</th>
                                                    <th className="px-4 py-3 text-gray-400 font-semibold text-xs uppercase tracking-wider">Share</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-800/50">
                                                {agentTotals.map((ac, idx) => {
                                                    const share = totalCost30d > 0 ? (ac.totalCost / totalCost30d) * 100 : 0;
                                                    const costPer1k = ac.totalTokens > 0 ? (ac.totalCost / ac.totalTokens) * 1000 : 0;
                                                    return (
                                                        <tr key={ac.agentId} className="hover:bg-gray-800/40 transition-colors">
                                                            <td className="px-4 py-4">
                                                                <div className="flex items-center gap-3">
                                                                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                                                                    <span className="text-white font-medium">{ac.agentName}</span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-4 text-right font-mono text-purple-300">{ac.totalTokens.toLocaleString()}</td>
                                                            <td className="px-4 py-4 text-right font-mono text-green-400">{formatCost(ac.totalCost)}</td>
                                                            <td className="px-4 py-4 text-right font-mono text-gray-400">{formatCost(costPer1k)}</td>
                                                            <td className="px-4 py-4">
                                                                <div className="flex items-center gap-2">
                                                                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden max-w-[80px]">
                                                                        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(share, 100)}%`, backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] }} />
                                                                    </div>
                                                                    <span className="text-xs text-gray-500 font-mono w-10 text-right">{share.toFixed(1)}%</span>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })()}
            </div>
        </div>
    );
}

export default App;
