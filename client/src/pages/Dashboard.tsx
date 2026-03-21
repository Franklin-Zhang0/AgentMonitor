import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Agent } from '../api/client';
import { getSocket } from '../api/socket';
import { useTranslation } from '../i18n';

export function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [retentionHours, setRetentionHours] = useState(24);
  const navigate = useNavigate();
  const { t } = useTranslation();

  const fetchAgents = async () => {
    try {
      const data = await api.getAgents();
      setAgents(data);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const s = await api.getSettings();
      setRetentionHours(s.agentRetentionMs / 3_600_000);
    } catch {
      // ignore
    }
  };

  const handleSaveSettings = async () => {
    await api.updateSettings({ agentRetentionMs: retentionHours * 3_600_000 });
    setShowSettings(false);
  };

  useEffect(() => {
    fetchAgents();
    fetchSettings();

    const socket = getSocket();

    // Real-time: use agent:snapshot to update individual cards without full re-fetch
    let hasSnapshot = false;
    const onSnapshot = (data: { agentId: string; agent: Agent }) => {
      if (data.agent) {
        hasSnapshot = true;
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === data.agentId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data.agent;
            return next;
          }
          // New agent appeared
          return [...prev, data.agent];
        });
      }
    };

    // Fallback for status changes (e.g., stop/delete which don't emit snapshot)
    const onStatus = () => {
      if (!hasSnapshot) fetchAgents();
      // For 'deleted' status from cleanup, always re-fetch to remove cards
      fetchAgents();
    };

    socket.on('agent:snapshot', onSnapshot);
    socket.on('agent:status', onStatus);

    return () => {
      socket.off('agent:snapshot', onSnapshot);
      socket.off('agent:status', onStatus);
    };
  }, []);

  const handleStopAll = async () => {
    await api.stopAllAgents();
    fetchAgents();
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await api.deleteAgent(id);
    fetchAgents();
  };

  const handleStop = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await api.stopAgent(id);
    fetchAgents();
  };

  const formatDuration = (createdAt: number, lastActivity: number) => {
    const now = Date.now();
    const elapsed = Math.floor((lastActivity - createdAt) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const duration = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

    const agoSec = Math.floor((now - lastActivity) / 1000);
    const ago = agoSec < 60 ? `${agoSec}s ago`
      : agoSec < 3600 ? `${Math.floor(agoSec / 60)}m ago`
      : `${Math.floor(agoSec / 3600)}h ago`;

    return `${duration} · ${ago}`;
  };

  const getLastMessage = (agent: Agent) => {
    if (agent.messages.length === 0) return t('dashboard.noMessages');
    const last = agent.messages[agent.messages.length - 1];
    const text = last.content;
    return text.length > 100 ? text.slice(0, 100) + '...' : text;
  };

  if (loading) return <div>{t('common.loading')}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('dashboard.title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => navigate('/create')}>
            {t('dashboard.newAgent')}
          </button>
          {agents.length > 0 && (
            <button className="btn btn-danger" onClick={handleStopAll}>
              {t('dashboard.stopAll')}
            </button>
          )}
          <button className="btn btn-outline" onClick={() => setShowSettings(true)} title={t('dashboard.settings')} style={{ fontSize: 30, lineHeight: 1 }}>
            &#9881;
          </button>
        </div>
      </div>

      {agents.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          {t('dashboard.empty')}
        </div>
      ) : (
        <div className="card-grid">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="card"
              onClick={() => navigate(`/agent/${agent.id}`)}
            >
              <div className="card-header">
                <span className="card-name">
                  <span className={`provider-badge provider-${agent.config.provider || 'claude'}`}>
                    {(agent.config.provider || 'claude').toUpperCase()}
                  </span>
                  {' '}{agent.name}
                </span>
                <span className={`status status-${agent.status}`}>
                  <span className="status-dot" />
                  {agent.status}
                </span>
              </div>

              {/* Project & Branch */}
              <div className="card-meta">
                <span className="card-meta-item" title={agent.config.directory}>
                  <span className="card-meta-icon">&#128193;</span>
                  {agent.projectName || agent.config.directory.split('/').pop()}
                  {agent.worktreeBranch && (
                    <span className="card-branch">
                      <svg className="branch-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                      </svg>
                      {agent.worktreeBranch}
                    </span>
                  )}
                </span>
                {agent.prUrl && (
                  <a
                    className="card-pr-link"
                    href={agent.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
                    </svg>
                    PR #{agent.prUrl.split('/').pop()}
                  </a>
                )}
              </div>

              {/* Model & Context */}
              <div className="card-meta">
                {typeof agent.config.flags.model === 'string' && agent.config.flags.model && (
                  <span className="card-meta-item">
                    <svg className="card-meta-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                      <path d="M5.433 2.304A4.492 4.492 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.902 1.64v.008l-.164 3.092a.75.75 0 1 1-1.498-.08l.164-3.084c.007-.13-.112-.383-.527-.626A5.98 5.98 0 0 1 1.5 6a5.993 5.993 0 0 1 2.567-4.92.75.75 0 1 1 .866 1.224Zm5.135 0a.75.75 0 0 1 .866-1.224A5.993 5.993 0 0 1 14 6a5.98 5.98 0 0 1-2.967 5.178c-.414.243-.534.496-.527.626l.164 3.084a.75.75 0 1 1-1.498.08l-.164-3.092v-.008c-.027-.717.384-1.312.902-1.64A4.492 4.492 0 0 0 12 6a4.492 4.492 0 0 0-1.433-3.696Z" />
                    </svg>
                    {String(agent.config.flags.model)}
                  </span>
                )}
                {agent.contextWindow && (
                  <span className="card-meta-item card-context">
                    <span className="card-context-bar">
                      <span
                        className="card-context-fill"
                        style={{ width: `${Math.min(100, (agent.contextWindow.used / agent.contextWindow.total) * 100)}%` }}
                      />
                    </span>
                    {Math.round((agent.contextWindow.used / agent.contextWindow.total) * 100)}%
                  </span>
                )}
              </div>

              {/* Task description */}
              <div className="card-body">
                {agent.currentTask || getLastMessage(agent)}
              </div>

              {/* MCP Servers */}
              {agent.mcpServers && agent.mcpServers.length > 0 && (
                <div className="card-mcp">
                  {agent.mcpServers.map((s) => (
                    <span key={s} className="card-mcp-tag">{s}</span>
                  ))}
                </div>
              )}

              <div className="card-footer">
                <span>{formatDuration(agent.createdAt, agent.lastActivity)}</span>
                {agent.costUsd !== undefined && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    ${agent.costUsd.toFixed(4)}
                  </span>
                )}
                {agent.tokenUsage && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {agent.tokenUsage.input + agent.tokenUsage.output} {t('common.tokens')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  className="btn btn-sm btn-outline"
                  onClick={(e) => { e.stopPropagation(); navigate(`/create?from=${agent.id}`); }}
                  title={t('dashboard.cloneAgent')}
                >
                  {t('dashboard.clone')}
                </button>
                {(agent.status === 'running' || agent.status === 'waiting_input') && (
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={(e) => handleStop(e, agent.id)}
                  >
                    {t('common.stop')}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={(e) => handleDelete(e, agent.id)}
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('dashboard.settings')}</h2>
            <div className="form-group">
              <label>{t('dashboard.retentionHours')}</label>
              <input
                type="number"
                min="0"
                step="1"
                value={retentionHours}
                onChange={(e) => setRetentionHours(Math.max(0, Number(e.target.value)))}
                placeholder={t('dashboard.retentionDisabled')}
              />
              {retentionHours === 0 && (
                <small style={{ color: 'var(--text-muted)' }}>{t('dashboard.retentionDisabled')}</small>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-outline" onClick={() => setShowSettings(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn" onClick={handleSaveSettings}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
