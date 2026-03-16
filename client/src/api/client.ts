const BASE = '/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    // Redirect to login on 401 (relay auth required)
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export type AgentProvider = 'claude' | 'codex';

export interface AgentFlags {
  dangerouslySkipPermissions?: boolean;
  resume?: string;
  model?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fullAuto?: boolean;
  chrome?: boolean;
  permissionMode?: string;
  maxBudgetUsd?: number;
  allowedTools?: string;
  disallowedTools?: string;
  addDirs?: string;
  mcpConfig?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'waiting_input';
  config: {
    provider: AgentProvider;
    directory: string;
    prompt: string;
    claudeMd?: string;
    adminEmail?: string;
    whatsappPhone?: string;
    slackWebhookUrl?: string;
    flags: AgentFlags;
  };
  worktreePath?: string;
  worktreeBranch?: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
  }>;
  lastActivity: number;
  createdAt: number;
  costUsd?: number;
  tokenUsage?: { input: number; output: number };
  projectName?: string;
  prUrl?: string;
  mcpServers?: string[];
  contextWindow?: { used: number; total: number };
  currentTask?: string;
}

export interface Template {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  lastModified: number;
}

export interface InstalledSkill {
  name: string;
  command: string;
  description: string;
  source: string;
}

export interface DirListing {
  path: string;
  parent: string;
  entries: Array<{ name: string; path: string; isDirectory: boolean }>;
}

export interface PipelineTask {
  id: string;
  name: string;
  prompt: string;
  directory?: string;
  provider?: AgentProvider;
  model?: string;
  claudeMd?: string;
  flags?: {
    dangerouslySkipPermissions?: boolean;
    fullAuto?: boolean;
    chrome?: boolean;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  status: 'pending' | 'running' | 'completed' | 'failed';
  agentId?: string;
  order: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface MetaAgentConfig {
  running: boolean;
  agentId?: string;
  claudeMd: string;
  defaultDirectory: string;
  defaultProvider: AgentProvider;
  pollIntervalMs: number;
  adminEmail?: string;
  whatsappPhone?: string;
  slackWebhookUrl?: string;
  stuckTimeoutMs?: number;
}

export interface ServerSettings {
  agentRetentionMs: number;
  promptSuggestions: string[];
}

export const api = {
  // Agents
  getAgents: () => request<Agent[]>('/agents'),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  createAgent: (data: {
    name: string;
    provider?: AgentProvider;
    directory: string;
    prompt: string;
    claudeMd?: string;
    adminEmail?: string;
    whatsappPhone?: string;
    slackWebhookUrl?: string;
    flags?: AgentFlags;
  }) => request<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  stopAgent: (id: string) =>
    request('/agents/' + id + '/stop', { method: 'POST' }),
  stopAllAgents: () =>
    request('/agents/actions/stop-all', { method: 'POST' }),
  deleteAgent: (id: string) =>
    request('/agents/' + id, { method: 'DELETE' }),
  sendMessage: (id: string, text: string) =>
    request('/agents/' + id + '/message', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  rewindAgent: (id: string, messageId: string) =>
    request('/agents/' + id + '/rewind', {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),
  interruptAgent: (id: string) =>
    request('/agents/' + id + '/interrupt', { method: 'POST' }),
  renameAgent: (id: string, name: string) =>
    request('/agents/' + id + '/rename', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  updateAgentPermissions: (id: string, permissionMode?: string) =>
    request('/agents/' + id + '/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissionMode }),
    }),
  updateClaudeMd: (id: string, content: string) =>
    request('/agents/' + id + '/claude-md', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Templates
  getTemplates: () => request<Template[]>('/templates'),
  getTemplate: (id: string) => request<Template>(`/templates/${id}`),
  createTemplate: (data: { name: string; content: string }) =>
    request<Template>('/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateTemplate: (id: string, data: { name?: string; content?: string }) =>
    request<Template>(`/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteTemplate: (id: string) =>
    request(`/templates/${id}`, { method: 'DELETE' }),

  // Sessions
  getSessions: () => request<SessionInfo[]>('/sessions'),

  // Skills
  getSkills: (provider: AgentProvider) =>
    request<InstalledSkill[]>(`/skills?provider=${encodeURIComponent(provider)}`),

  // Directories
  listDirectory: (path?: string) =>
    request<DirListing>(`/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  checkClaudeMd: (path: string) =>
    request<{ exists: boolean; content?: string }>(`/directories/claude-md?path=${encodeURIComponent(path)}`),

  // Pipeline Tasks
  getTasks: () => request<PipelineTask[]>('/tasks'),
  getTask: (id: string) => request<PipelineTask>(`/tasks/${id}`),
  createTask: (data: {
    name: string;
    prompt: string;
    directory?: string;
    provider?: AgentProvider;
    model?: string;
    claudeMd?: string;
    flags?: PipelineTask['flags'];
    order?: number;
  }) => request<PipelineTask>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<PipelineTask>) =>
    request<PipelineTask>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
  resetTask: (id: string) => request<PipelineTask>(`/tasks/${id}/reset`, { method: 'POST' }),
  clearCompletedTasks: () => request('/tasks/actions/clear-completed', { method: 'POST' }),

  // Meta Agent
  getMetaConfig: () => request<MetaAgentConfig>('/tasks/meta/config'),
  updateMetaConfig: (data: Partial<MetaAgentConfig>) =>
    request<MetaAgentConfig>('/tasks/meta/config', { method: 'PUT', body: JSON.stringify(data) }),
  startMetaAgent: () => request('/tasks/meta/start', { method: 'POST' }),
  stopMetaAgent: () => request('/tasks/meta/stop', { method: 'POST' }),
  getMetaStatus: () => request<{ running: boolean }>('/tasks/meta/status'),

  // Server Settings
  getSettings: () => request<ServerSettings>('/settings'),
  updateSettings: (data: Partial<ServerSettings>) =>
    request<ServerSettings>('/settings', { method: 'PUT', body: JSON.stringify(data) }),
};
