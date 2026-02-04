import { tokenize } from './utils.js';
export function pickAgent(agents, options) {
    const list = Array.isArray(agents) ? agents : [];
    if (list.length === 0)
        return null;
    const desiredCategory = normalizeToken(options.category);
    const desiredSkills = (options.skills || []).map(normalizeToken).filter(Boolean);
    const queryTokens = tokenize(options.query);
    const taskTokens = tokenize(options.task);
    const commandId = normalizeToken(options.commandId);
    let best = null;
    for (const agent of list) {
        const agentCategory = normalizeToken(agent.category);
        if (desiredCategory && agentCategory && desiredCategory !== agentCategory) {
            continue;
        }
        const commands = Array.isArray(agent.commands) ? agent.commands : [];
        const matchedCommand = resolveCommand(commands, commandId);
        if (commandId && !matchedCommand) {
            continue;
        }
        const agentSkills = (agent.skills || []).map(normalizeToken).filter(Boolean);
        const agentTokens = new Set([
            ...tokenize(agent.name),
            ...tokenize(agent.description),
            ...tokenize(agentCategory),
            ...agentSkills,
            ...flattenCommandTokens(commands),
        ]);
        const skillMatches = desiredSkills.filter((skill) => agentSkills.includes(skill));
        const queryMatches = queryTokens.filter((token) => agentTokens.has(token));
        const taskMatches = taskTokens.filter((token) => agentTokens.has(token));
        let score = 0;
        if (desiredCategory && agentCategory && desiredCategory === agentCategory)
            score += 4;
        score += skillMatches.length * 3;
        score += queryMatches.length * 2;
        score += taskMatches.length;
        if (commandId && matchedCommand)
            score += 5;
        const usedSkills = desiredSkills.length > 0 ? desiredSkills : agentSkills;
        const reasonParts = [];
        if (desiredCategory && agentCategory === desiredCategory)
            reasonParts.push(`category:${desiredCategory}`);
        if (skillMatches.length > 0)
            reasonParts.push(`skills:${skillMatches.join(',')}`);
        if (queryMatches.length > 0)
            reasonParts.push(`query:${queryMatches.join(',')}`);
        if (taskMatches.length > 0)
            reasonParts.push(`task:${taskMatches.join(',')}`);
        if (commandId && matchedCommand)
            reasonParts.push(`command:${commandId}`);
        const reason = reasonParts.length > 0 ? reasonParts.join(' | ') : 'Best available match';
        const current = {
            agent,
            command: matchedCommand || pickDefaultCommand(commands, agent.defaultCommand),
            score,
            reason,
            usedSkills,
        };
        if (!best || current.score > best.score) {
            best = current;
        }
    }
    return best;
}
function resolveCommand(commands, commandId) {
    const id = normalizeToken(commandId);
    if (!id)
        return null;
    return (commands.find((cmd) => normalizeToken(cmd.id) === id) ||
        commands.find((cmd) => normalizeToken(cmd.name) === id) ||
        null);
}
export function pickDefaultCommand(commands, preferredId) {
    const preferred = resolveCommand(commands, preferredId);
    if (preferred)
        return preferred;
    return commands.length > 0 ? commands[0] : null;
}
function flattenCommandTokens(commands) {
    const tokens = [];
    for (const cmd of commands) {
        tokens.push(...tokenize(cmd.id));
        tokens.push(...tokenize(cmd.name));
        tokens.push(...tokenize(cmd.description));
    }
    return tokens;
}
function normalizeToken(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
