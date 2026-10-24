export const DEFAULT_LOOP_LIMIT = 30;
export const DEFAULT_TOOL_RESULT_DELAY_SECONDS = 2;
export const MAX_TOOL_RESULT_DELAY_SECONDS = 300;

export function normalizeToolResultDelaySeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_TOOL_RESULT_DELAY_SECONDS) : DEFAULT_TOOL_RESULT_DELAY_SECONDS;
}

export const PERMISSION_MODES = {
  full: { label: 'Full access', description: 'Run tools and unrestricted shell commands without approval prompts.' },
  important: { label: 'Ask for important commands', description: 'Ask before sensitive file changes and commands outside the safe list.' },
  always: { label: 'Ask every time', description: 'Ask before every tool call, including reads and handoffs.' },
} as const;

export type PermissionMode = keyof typeof PERMISSION_MODES;
export type ToolArguments = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  params: Record<string, unknown>;
}

export interface ToolCall {
  tool: string;
  args: ToolArguments;
  summary?: string;
}

export interface BridgeRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface PanelState {
  connected: boolean;
  enabled: boolean;
  status: string;
  run: unknown;
  tools: { tools: ToolDefinition[] } | null;
  loopsLeft: number;
  loopLimit: number;
}

/** The transport deliberately supports only a loopback HTTP bridge. */
export function normalizeBridgeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Bridge URL must be http://127.0.0.1:<port> with no path or credentials.');
  }
  return url.origin;
}
