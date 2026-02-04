import fs from 'fs';
import path from 'path';
import { safeJsonParse, ensureDir } from './utils.js';
export class AgentRegistry {
    filePath;
    data;
    constructor(stateDir, filePath) {
        ensureDir(stateDir);
        this.filePath = filePath ? path.resolve(filePath) : path.join(stateDir, 'subagents.json');
        this.data = this.load();
    }
    load() {
        if (!fs.existsSync(this.filePath)) {
            const initial = { agents: [] };
            fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
            return initial;
        }
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = safeJsonParse(raw, { agents: [] });
        if (!Array.isArray(parsed.agents)) {
            parsed.agents = [];
        }
        return parsed;
    }
    save(data) {
        this.data = data;
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    }
    getFilePath() {
        return this.filePath;
    }
    listAgents() {
        return this.data.agents.slice();
    }
    getAgent(id) {
        return this.data.agents.find((a) => a.id === id) || null;
    }
    upsertAgent(agent) {
        const index = this.data.agents.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
            this.data.agents[index] = agent;
        }
        else {
            this.data.agents.push(agent);
        }
        this.save(this.data);
    }
}
