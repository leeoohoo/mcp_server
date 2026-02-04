import fs from 'fs';
import path from 'path';
import { AgentSpec, RegistryData } from './types.js';
import { safeJsonParse, ensureDir } from './utils.js';

export class AgentRegistry {
  private filePath: string;
  private data: RegistryData;

  constructor(stateDir: string, filePath?: string) {
    ensureDir(stateDir);
    this.filePath = filePath ? path.resolve(filePath) : path.join(stateDir, 'subagents.json');
    this.data = this.load();
  }

  load(): RegistryData {
    if (!fs.existsSync(this.filePath)) {
      const initial: RegistryData = { agents: [] };
      fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = safeJsonParse<RegistryData>(raw, { agents: [] });
    if (!Array.isArray(parsed.agents)) {
      parsed.agents = [];
    }
    return parsed;
  }

  save(data: RegistryData) {
    this.data = data;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getFilePath(): string {
    return this.filePath;
  }

  listAgents(): AgentSpec[] {
    return this.data.agents.slice();
  }

  getAgent(id: string): AgentSpec | null {
    return this.data.agents.find((a) => a.id === id) || null;
  }

  upsertAgent(agent: AgentSpec) {
    const index = this.data.agents.findIndex((a) => a.id === agent.id);
    if (index >= 0) {
      this.data.agents[index] = agent;
    } else {
      this.data.agents.push(agent);
    }
    this.save(this.data);
  }
}
