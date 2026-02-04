import fs from 'fs';
import path from 'path';
export function loadMarketplace(options) {
    const marketplacePath = options.marketplacePath;
    if (!marketplacePath || !fs.existsSync(marketplacePath)) {
        return { agents: [], skills: [] };
    }
    let raw;
    try {
        raw = fs.readFileSync(marketplacePath, 'utf8');
    }
    catch {
        return { agents: [], skills: [] };
    }
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { agents: [], skills: [] };
    }
    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    if (plugins.length === 0)
        return { agents: [], skills: [] };
    const marketplaceDir = path.dirname(marketplacePath);
    const agents = [];
    const skills = [];
    const skillIds = new Set();
    for (const plugin of plugins) {
        const pluginName = String(plugin?.name || '').trim();
        const pluginCategory = String(plugin?.category || '').trim() || undefined;
        const sourceRaw = String(plugin?.source || '').trim();
        if (!sourceRaw)
            continue;
        const pluginRoot = resolvePluginRoot(sourceRaw, marketplaceDir, options.pluginsRoot);
        if (!fs.existsSync(pluginRoot))
            continue;
        const commandSpecs = buildCommandSpecs(pluginRoot, plugin?.commands || []);
        const skillSpecs = buildSkillSpecs(pluginRoot, plugin?.skills || [], pluginName);
        for (const skill of skillSpecs) {
            if (skillIds.has(skill.id))
                continue;
            skillIds.add(skill.id);
            skills.push(skill);
        }
        const skillIdsForPlugin = skillSpecs.map((skill) => skill.id);
        const agentPaths = Array.isArray(plugin?.agents) ? plugin.agents : [];
        for (const agentPath of agentPaths) {
            const resolved = resolveMarkdownPath(pluginRoot, agentPath);
            if (!resolved || !fs.existsSync(resolved))
                continue;
            const meta = readMarkdownMeta(resolved);
            const id = deriveId(resolved);
            const agent = {
                id,
                name: meta.title || id,
                description: meta.description || plugin?.description || '',
                category: pluginCategory,
                skills: skillIdsForPlugin.slice(),
                defaultSkills: skillIdsForPlugin.slice(),
                commands: commandSpecs.map((cmd) => ({ ...cmd })),
                defaultCommand: commandSpecs.length > 0 ? commandSpecs[0].id : undefined,
                systemPromptPath: resolved,
                plugin: pluginName || undefined,
            };
            agents.push(agent);
        }
    }
    return { agents, skills };
}
function resolvePluginRoot(source, marketplaceDir, pluginsRoot) {
    if (path.isAbsolute(source))
        return source;
    if (pluginsRoot && pluginsRoot.trim()) {
        return path.resolve(pluginsRoot, source);
    }
    return path.resolve(marketplaceDir, source);
}
function buildCommandSpecs(root, entries) {
    const specs = [];
    for (const entry of entries || []) {
        const resolved = resolveMarkdownPath(root, entry);
        if (!resolved || !fs.existsSync(resolved))
            continue;
        const meta = readMarkdownMeta(resolved);
        const id = deriveId(resolved);
        specs.push({
            id,
            name: meta.title || id,
            description: meta.description || '',
            instructionsPath: resolved,
        });
    }
    return specs;
}
function buildSkillSpecs(root, entries, plugin) {
    const specs = [];
    for (const entry of entries || []) {
        const resolved = resolveMarkdownPath(root, entry);
        if (!resolved || !fs.existsSync(resolved))
            continue;
        const meta = readMarkdownMeta(resolved);
        const id = deriveId(resolved);
        specs.push({
            id,
            name: meta.title || id,
            description: meta.description || '',
            path: resolved,
            plugin,
        });
    }
    return specs;
}
function resolveMarkdownPath(root, rawPath) {
    if (!rawPath)
        return '';
    const trimmed = String(rawPath || '').trim();
    if (!trimmed)
        return '';
    if (path.isAbsolute(trimmed))
        return trimmed;
    let resolved = path.resolve(root, trimmed);
    if (fs.existsSync(resolved))
        return resolved;
    if (!path.extname(resolved)) {
        const withMd = `${resolved}.md`;
        if (fs.existsSync(withMd))
            return withMd;
        const withSkill = path.join(resolved, 'SKILL.md');
        if (fs.existsSync(withSkill))
            return withSkill;
        const withIndex = path.join(resolved, 'index.md');
        if (fs.existsSync(withIndex))
            return withIndex;
    }
    return resolved;
}
function readMarkdownMeta(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/);
        let title = '';
        let description = '';
        let foundTitle = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!foundTitle && trimmed.startsWith('#')) {
                title = trimmed.replace(/^#+\s*/, '').trim();
                foundTitle = true;
                continue;
            }
            if (foundTitle && !description && trimmed && !trimmed.startsWith('#')) {
                description = trimmed;
                break;
            }
        }
        return { title, description };
    }
    catch {
        return { title: '', description: '' };
    }
}
function deriveId(resolvedPath) {
    const base = path.basename(resolvedPath);
    const lower = base.toLowerCase();
    let raw = '';
    if (lower === 'skill.md' || lower === 'index.md') {
        raw = path.basename(path.dirname(resolvedPath));
    }
    else {
        raw = path.basename(resolvedPath, path.extname(resolvedPath));
    }
    return slugify(raw);
}
function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}
