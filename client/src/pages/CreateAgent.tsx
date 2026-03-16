import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type AgentProvider, type AgentFlags, type Template, type SessionInfo, type DirListing, type ServerSettings } from '../api/client';
import { useTranslation } from '../i18n';

function getPermissionOptions(provider: AgentProvider) {
  if (provider === 'codex') {
    return [
      { value: 'default', label: 'Default' },
      { value: 'readOnly', label: 'Read-only approvals' },
      { value: 'workspaceWrite', label: 'Workspace-write approvals' },
      { value: 'fullAuto', label: 'Full auto' },
      { value: 'bypassPermissions', label: 'Bypass approvals and sandbox' },
    ];
  }

  return [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'bypassPermissions', label: 'Bypass permissions' },
    { value: 'dontAsk', label: 'Do not ask' },
    { value: 'plan', label: 'Plan mode' },
  ];
}

function getInitialPermissionMode(provider: AgentProvider, flags: AgentFlags): string {
  if (typeof flags.permissionMode === 'string' && flags.permissionMode) {
    return flags.permissionMode;
  }

  if (provider === 'codex') {
    if (flags.fullAuto) return 'fullAuto';
    if (flags.dangerouslySkipPermissions) return 'bypassPermissions';
    return 'default';
  }

  if (flags.dangerouslySkipPermissions) {
    return 'bypassPermissions';
  }

  return 'default';
}

export function CreateAgent() {
  type EffortLevel = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const [cloneSource, setCloneSource] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [prompt, setPrompt] = useState('');
  const [claudeMd, setClaudeMd] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [chrome, setChrome] = useState(false);
  const [permissionMode, setPermissionMode] = useState('default');
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [disallowedTools, setDisallowedTools] = useState('');
  const [addDirs, setAddDirs] = useState('');
  const [mcpConfig, setMcpConfig] = useState('');
  const [resumeSession, setResumeSession] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('default');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const instructionFileName = provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';

  // Directory browser
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [showDirBrowser, setShowDirBrowser] = useState(false);
  const [claudeMdPrompt, setClaudeMdPrompt] = useState<{ content: string } | null>(null);

  // Templates, sessions, and prompt suggestions
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [promptSuggestions, setPromptSuggestions] = useState<string[]>([]);
  const [newSuggestion, setNewSuggestion] = useState('');
  const [showAddSuggestion, setShowAddSuggestion] = useState(false);

  useEffect(() => {
    api.getTemplates().then(setTemplates).catch(() => {});
    api.getSessions().then(setSessions).catch(() => {});
    api.getSettings().then((s) => setPromptSuggestions(s.promptSuggestions || [])).catch(() => {});

    // Clone from existing agent
    const fromId = searchParams.get('from');
    if (fromId) {
      api.getAgent(fromId).then((source) => {
        setCloneSource(source.name);
        setProvider(source.config.provider);
        setName(`${source.name} (copy)`);
        setDirectory(source.config.directory);
        setPrompt(source.config.prompt);
        setClaudeMd(source.config.claudeMd || '');
        setAdminEmail(source.config.adminEmail || '');
        setWhatsappPhone(source.config.whatsappPhone || '');
        setSlackWebhookUrl(source.config.slackWebhookUrl || '');
        const f = source.config.flags || {};
        setChrome(!!f.chrome);
        setPermissionMode(getInitialPermissionMode(source.config.provider, f));
        setMaxBudgetUsd(f.maxBudgetUsd ? String(f.maxBudgetUsd) : '');
        setAllowedTools((f.allowedTools as string) || '');
        setDisallowedTools((f.disallowedTools as string) || '');
        setAddDirs((f.addDirs as string) || '');
        setMcpConfig((f.mcpConfig as string) || '');
        setModel((f.model as string) || '');
      }).catch(() => {});
    }
  }, [searchParams]);

  useEffect(() => {
    const validValues = new Set(getPermissionOptions(provider).map((option) => option.value));
    if (!validValues.has(permissionMode)) {
      setPermissionMode('default');
    }
  }, [provider, permissionMode]);
  const addSuggestion = async () => {
    const text = newSuggestion.trim();
    if (!text) return;
    const updated = [...promptSuggestions, text];
    setPromptSuggestions(updated);
    setNewSuggestion('');
    setShowAddSuggestion(false);
    try { await api.updateSettings({ promptSuggestions: updated }); } catch {}
  };

  const removeSuggestion = async (index: number) => {
    const updated = promptSuggestions.filter((_, i) => i !== index);
    setPromptSuggestions(updated);
    try { await api.updateSettings({ promptSuggestions: updated }); } catch {}
  };

  const browseTo = async (path?: string) => {
    try {
      const listing = await api.listDirectory(path);
      setDirListing(listing);
      setShowDirBrowser(true);
    } catch (err) {
      setError(String(err));
    }
  };

  const selectDir = async (path: string) => {
    setDirectory(path);
    setShowDirBrowser(false);
    try {
      const result = await api.checkClaudeMd(path);
      if (result.exists && result.content) {
        setClaudeMdPrompt({ content: result.content });
      }
    } catch {}
  };

  const handleTemplateSelect = (templateId: string) => {
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl) setClaudeMd(tmpl.content);
  };

  const handleCreate = async () => {
    if (!name || !directory || !prompt) {
      setError(t('create.requiredFields'));
      return;
    }
    setCreating(true);
    setError('');
    try {
      const agent = await api.createAgent({
        name,
        provider,
        directory,
        prompt,
        claudeMd: claudeMd || undefined,
        adminEmail: adminEmail || undefined,
        whatsappPhone: whatsappPhone || undefined,
        slackWebhookUrl: slackWebhookUrl || undefined,
        flags: {
          dangerouslySkipPermissions:
            provider === 'claude' && ['bypassPermissions', 'dontAsk'].includes(permissionMode)
              ? true
              : provider === 'codex' && permissionMode === 'bypassPermissions'
                ? true
                : undefined,
          fullAuto: provider === 'codex' && permissionMode === 'fullAuto' ? true : undefined,
          chrome: chrome || undefined,
          permissionMode: permissionMode || undefined,
          maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
          allowedTools: allowedTools || undefined,
          disallowedTools: disallowedTools || undefined,
          addDirs: addDirs || undefined,
          mcpConfig: mcpConfig || undefined,
          resume: resumeSession || undefined,
          model: model || undefined,
          effort: effort !== 'default' ? effort : undefined,
        },
      });
      navigate(`/agent/${agent.id}`);
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  };

  return (
    <div style={{ maxWidth: 700 }}>
      <div className="page-header">
        <h1 className="page-title">
          {cloneSource ? `${t('create.cloneFrom')} ${cloneSource}` : t('create.title')}
        </h1>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--red)', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div className="form-group">
        <label>{t('common.provider')}</label>
        <div className="provider-selector">
          <button
            className={`provider-btn ${provider === 'claude' ? 'active' : ''}`}
            onClick={() => setProvider('claude')}
            type="button"
          >
            {t('common.claudeCode')}
          </button>
          <button
            className={`provider-btn ${provider === 'codex' ? 'active' : ''}`}
            onClick={() => setProvider('codex')}
            type="button"
          >
            {t('common.codex')}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>{t('create.name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('create.namePlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('create.workingDir')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder={t('create.workingDirPlaceholder')}
          />
          <button className="btn btn-outline" onClick={() => showDirBrowser ? setShowDirBrowser(false) : browseTo(directory || undefined)}>
            {t('common.browse')}
          </button>
        </div>
      </div>

      {showDirBrowser && dirListing && (
        <div className="dir-browser" style={{ marginBottom: 16 }}>
          <div
            className="dir-entry is-dir"
            onClick={() => browseTo(dirListing.parent)}
          >
            ..
          </div>
          {dirListing.entries
            .filter((e) => e.isDirectory)
            .map((entry) => (
              <div key={entry.path} className="dir-entry is-dir" style={{ display: 'flex', gap: 8 }}>
                <span onClick={() => browseTo(entry.path)} style={{ flex: 1 }}>
                  {entry.name}/
                </span>
                <button className="btn btn-sm" onClick={() => selectDir(entry.path)}>
                  {t('common.select')}
                </button>
              </div>
            ))}
          <div style={{ padding: '6px 12px' }}>
            <button className="btn btn-sm" onClick={() => selectDir(dirListing.path)}>
              {t('create.selectCurrent')} {dirListing.path}
            </button>
          </div>
        </div>
      )}

      {claudeMdPrompt && (
        <div style={{ padding: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 16 }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>{t('create.claudeMdFound')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => { setClaudeMd(claudeMdPrompt.content); setClaudeMdPrompt(null); }}>
              {t('create.loadExisting')}
            </button>
            <button className="btn btn-sm btn-outline" onClick={() => setClaudeMdPrompt(null)}>
              {t('create.keepCustom')}
            </button>
          </div>
        </div>
      )}

      <div className="form-group">
        <label>{t('create.prompt')}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('create.promptPlaceholder')}
        />
        {promptSuggestions.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {promptSuggestions.map((s, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', fontSize: 12, borderRadius: 12,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  cursor: 'pointer', maxWidth: '100%',
                }}
              >
                <span
                  onClick={() => setPrompt(prev => prev ? prev + '\n' + s : s)}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={s}
                >
                  {s}
                </span>
                <span
                  onClick={(e) => { e.stopPropagation(); removeSuggestion(i); }}
                  style={{ cursor: 'pointer', opacity: 0.5, fontSize: 14, lineHeight: 1, flexShrink: 0 }}
                  title={t('create.removeSuggestion')}
                >&times;</span>
              </span>
            ))}
            {!showAddSuggestion && (
              <span
                onClick={() => setShowAddSuggestion(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '4px 10px', fontSize: 12, borderRadius: 12,
                  background: 'var(--bg-card)', border: '1px dashed var(--border)',
                  cursor: 'pointer', opacity: 0.7,
                }}
                title={t('create.addSuggestion')}
              >+ {t('create.addSuggestion')}</span>
            )}
          </div>
        )}
        {promptSuggestions.length === 0 && (
          <div style={{ marginTop: 8 }}>
            <span
              onClick={() => setShowAddSuggestion(true)}
              style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '4px 10px', fontSize: 12, borderRadius: 12,
                background: 'var(--bg-card)', border: '1px dashed var(--border)',
                cursor: 'pointer', opacity: 0.7,
              }}
            >+ {t('create.addSuggestion')}</span>
          </div>
        )}
        {showAddSuggestion && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              value={newSuggestion}
              onChange={(e) => setNewSuggestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSuggestion()}
              placeholder={t('create.suggestionPlaceholder')}
              style={{ flex: 1, fontSize: 12 }}
              autoFocus
            />
            <button className="btn btn-sm" onClick={addSuggestion}>{t('common.save')}</button>
            <button className="btn btn-sm btn-outline" onClick={() => { setShowAddSuggestion(false); setNewSuggestion(''); }}>{t('common.cancel')}</button>
          </div>
        )}
      </div>

      <div className="form-group">
        <label>{t('create.model')}</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={provider === 'claude' ? 'e.g. claude-sonnet-4-5-20250514' : 'e.g. o3'}
        />
      </div>

      <div className="form-group">
        <label>{t('create.effort')}</label>
        <div className="provider-selector">
          <button
            className={`provider-btn ${effort === 'default' ? 'active' : ''}`}
            type="button"
            onClick={() => setEffort('default')}
          >
            {t('create.effortAuto')}
          </button>
          {provider === 'codex' && (
            <button
              className={`provider-btn ${effort === 'minimal' ? 'active' : ''}`}
              type="button"
              onClick={() => setEffort('minimal')}
            >
              {t('create.effortMinimal')}
            </button>
          )}
          <button
            className={`provider-btn ${effort === 'low' ? 'active' : ''}`}
            type="button"
            onClick={() => setEffort('low')}
          >
            {t('create.effortLow')}
          </button>
          <button
            className={`provider-btn ${effort === 'medium' ? 'active' : ''}`}
            type="button"
            onClick={() => setEffort('medium')}
          >
            {t('create.effortMedium')}
          </button>
          <button
            className={`provider-btn ${effort === 'high' ? 'active' : ''}`}
            type="button"
            onClick={() => setEffort('high')}
          >
            {t('create.effortHigh')}
          </button>
          {provider === 'codex' && (
            <button
              className={`provider-btn ${effort === 'xhigh' ? 'active' : ''}`}
              type="button"
              onClick={() => setEffort('xhigh')}
            >
              {t('create.effortXhigh')}
            </button>
          )}
        </div>
        {provider === 'codex' && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 6 }}>
            {t('create.effortModelDependent')}
          </div>
        )}
      </div>

      <div className="form-group">
        <label>Permission Level</label>
        <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
          {getPermissionOptions(provider).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>{t('create.flags')}</label>
        <div className="checkbox-group">
          {provider === 'claude' && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={chrome}
                onChange={(e) => setChrome(e.target.checked)}
              />
              --chrome
            </label>
          )}
        </div>
      </div>

      {provider === 'claude' && (
        <>
          <div className="form-group">
            <label>--max-budget-usd</label>
            <input
              value={maxBudgetUsd}
              onChange={(e) => setMaxBudgetUsd(e.target.value)}
              placeholder="e.g. 5.00"
              type="number"
              step="0.01"
              min="0"
            />
          </div>

          <div className="form-group">
            <label>--allowedTools</label>
            <input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder='e.g. Bash(git:*) Edit Read'
            />
          </div>

          <div className="form-group">
            <label>--disallowedTools</label>
            <input
              value={disallowedTools}
              onChange={(e) => setDisallowedTools(e.target.value)}
              placeholder='e.g. Bash(rm:*) Write'
            />
          </div>

          <div className="form-group">
            <label>--add-dir</label>
            <input
              value={addDirs}
              onChange={(e) => setAddDirs(e.target.value)}
              placeholder="Additional directories (comma-separated)"
            />
          </div>

          <div className="form-group">
            <label>--mcp-config</label>
            <input
              value={mcpConfig}
              onChange={(e) => setMcpConfig(e.target.value)}
              placeholder="Path to MCP config JSON file"
            />
          </div>
        </>
      )}

      {provider === 'claude' && (
        <div className="form-group">
          <label>{t('create.resumeSession')}</label>
          <select value={resumeSession} onChange={(e) => setResumeSession(e.target.value)}>
            <option value="">{t('create.newSession')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.projectPath} - {new Date(s.lastModified).toLocaleString()}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="form-group">
        <label>
          {instructionFileName}{' '}
          {templates.length > 0 && (
            <select
              style={{ marginLeft: 8, padding: '2px 4px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontSize: 12 }}
              onChange={(e) => handleTemplateSelect(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>{t('create.loadTemplate')}</option>
              {templates.map((tmpl) => (
                <option key={tmpl.id} value={tmpl.id}>{tmpl.name}</option>
              ))}
            </select>
          )}
        </label>
        <textarea
          value={claudeMd}
          onChange={(e) => setClaudeMd(e.target.value)}
          placeholder={provider === 'codex' ? 'Optional AGENTS.md content for the agent' : t('create.claudeMdPlaceholder')}
          style={{ minHeight: 160 }}
        />
      </div>

      <div className="form-group">
        <label>{t('create.adminEmail')}</label>
        <input
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder={t('create.adminEmailPlaceholder')}
          type="email"
        />
      </div>

      <div className="form-group">
        <label>{t('create.whatsappPhone')}</label>
        <input
          value={whatsappPhone}
          onChange={(e) => setWhatsappPhone(e.target.value)}
          placeholder={t('create.whatsappPhonePlaceholder')}
          type="tel"
        />
      </div>

      <div className="form-group">
        <label>{t('create.slackWebhook')}</label>
        <input
          value={slackWebhookUrl}
          onChange={(e) => setSlackWebhookUrl(e.target.value)}
          placeholder={t('create.slackWebhookPlaceholder')}
          type="url"
        />
      </div>

      <button className="btn" onClick={handleCreate} disabled={creating}>
        {creating ? t('create.creating') : t('create.createAgent')}
      </button>
    </div>
  );
}
