import fs from 'fs';
import path from 'path';
import { loadMarketplace } from './marketplace.js';
import { normalizeId } from './utils.js';
export class SubAgentCatalog {
    registry;
    marketplacePath;
    pluginsRoot;
    agents = new Map();
    skills = new Map();
    contentCache = new Map();
    constructor(options) {
        this.registry = options.registry;
        this.marketplacePath = options.marketplacePath;
        this.pluginsRoot = options.pluginsRoot;
        this.reload();
    }
    reload() {
        this.agents.clear();
        this.skills.clear();
        const marketplace = this.marketplacePath && fs.existsSync(this.marketplacePath)
            ? loadMarketplace({ marketplacePath: this.marketplacePath, pluginsRoot: this.pluginsRoot })
            : { agents: [], skills: [] };
        for (const skill of marketplace.skills) {
            if (!this.skills.has(skill.id)) {
                this.skills.set(skill.id, skill);
            }
        }
        for (const agent of marketplace.agents) {
            this.agents.set(agent.id, agent);
        }
        const registryAgents = this.registry.listAgents();
        for (const agent of registryAgents) {
            this.agents.set(agent.id, agent);
        }
    }
    listAgents() {
        return Array.from(this.agents.values());
    }
    getAgent(id) {
        const normalized = normalizeId(id);
        if (!normalized)
            return null;
        return this.agents.get(normalized) || null;
    }
    listSkills() {
        return Array.from(this.skills.values());
    }
    getSkill(id) {
        const normalized = normalizeId(id);
        if (!normalized)
            return null;
        return this.skills.get(normalized) || null;
    }
    resolveSkills(skillIds) {
        const result = [];
        for (const skillId of skillIds || []) {
            const normalized = normalizeId(skillId);
            if (!normalized)
                continue;
            const skill = this.skills.get(normalized);
            if (skill)
                result.push(skill);
        }
        return result;
    }
    resolveCommand(agent, commandId) {
        const commands = Array.isArray(agent.commands) ? agent.commands : [];
        if (!commandId) {
            return pickFirstCommand(commands, agent.defaultCommand);
        }
        const target = normalizeId(commandId).toLowerCase();
        return (commands.find((cmd) => normalizeId(cmd.id).toLowerCase() === target) ||
            commands.find((cmd) => normalizeId(cmd.name).toLowerCase() === target) ||
            null);
    }
    readContent(filePath) {
        if (!filePath)
            return '';
        const resolved = path.resolve(filePath);
        if (this.contentCache.has(resolved)) {
            return this.contentCache.get(resolved) || '';
        }
        let text = '';
        try {
            text = fs.readFileSync(resolved, 'utf8');
        }
        catch {
            text = '';
        }
        this.contentCache.set(resolved, text);
        return text;
    }
    setPluginsRoot(root) {
        this.pluginsRoot = root;
        this.reload();
    }
}
function pickFirstCommand(commands, preferredId) {
    if (!commands || commands.length === 0)
        return null;
    if (preferredId) {
        const target = normalizeId(preferredId).toLowerCase();
        const match = commands.find((cmd) => normalizeId(cmd.id).toLowerCase() === target) ||
            commands.find((cmd) => normalizeId(cmd.name).toLowerCase() === target);
        if (match)
            return match;
    }
    return commands[0];
}
