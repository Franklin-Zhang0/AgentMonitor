import type { Agent } from '../models/Agent.js';

/**
 * Normalize persisted context window values for UI/transport safety.
 * Older data may contain cumulative tokens in `used`, which can exceed `total`.
 */
export function sanitizeAgentSnapshot(agent: Agent): Agent {
  const context = agent.contextWindow;
  if (!context) return agent;

  const total = Number(context.total);
  const used = Number(context.used);
  if (!Number.isFinite(total) || total <= 0) {
    const { contextWindow: _drop, ...rest } = agent;
    return rest;
  }

  const normalizedUsed = Math.min(total, Math.max(0, Number.isFinite(used) ? used : 0));
  if (normalizedUsed === used && total === context.total) {
    return agent;
  }

  return {
    ...agent,
    contextWindow: {
      used: Math.round(normalizedUsed),
      total: Math.round(total),
    },
  };
}
