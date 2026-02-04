export interface CommandSpec {
  id: string;
  name?: string;
  description?: string;
  exec?: string[]; // command + args
  cwd?: string; // optional working directory
  env?: Record<string, string>;
  instructionsPath?: string;
}

export interface AgentSpec {
  id: string;
  name: string;
  description?: string;
  category?: string;
  skills?: string[];
  defaultSkills?: string[];
  commands?: CommandSpec[];
  defaultCommand?: string;
  systemPromptPath?: string;
  plugin?: string;
}

export interface RegistryData {
  agents: AgentSpec[];
}

export interface SkillSpec {
  id: string;
  name: string;
  description?: string;
  path: string;
  plugin?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobRecord {
  id: string;
  status: JobStatus;
  task: string;
  agentId: string | null;
  commandId: string | null;
  payloadJson: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  runId: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  payloadJson: string | null;
  createdAt: string;
  sessionId: string;
  runId: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  endpointUrl: string;
  headersJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
