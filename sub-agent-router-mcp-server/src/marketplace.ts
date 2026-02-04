import fs from 'fs';
import path from 'path';
import { AgentSpec, CommandSpec, SkillSpec } from './types.js';

interface MarketplaceFile {
  plugins?: PluginEntry[];
}

interface PluginEntry {
  name?: string;
  source?: string;
  category?: string;
  description?: string;
  agents?: string[];
  commands?: string[];
  skills?: string[];
}

export interface MarketplaceLoadOptions {
  marketplacePath: string;
  pluginsRoot?: string;
}

export interface MarketplaceResult {
  agents: AgentSpec[];
  skills: SkillSpec[];
}

export function loadMarketplace(options: MarketplaceLoadOptions): MarketplaceResult {
  const marketplacePath = options.marketplacePath;
  if (!marketplacePath || !fs.existsSync(marketplacePath)) {
    return { agents: [], skills: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(marketplacePath, 'utf8');
  } catch {
    return { agents: [], skills: [] };
  }
  let parsed: MarketplaceFile | null = null;
  try {
    parsed = JSON.parse(raw) as MarketplaceFile;
  } catch {
    return { agents: [], skills: [] };
  }
  const plugins = Array.isArray(parsed?.plugins) ? parsed!.plugins! : [];
  if (plugins.length === 0) return { agents: [], skills: [] };

  const marketplaceDir = path.dirname(marketplacePath);
  const agents: AgentSpec[] = [];
  const skills: SkillSpec[] = [];
  const skillIds = new Set<string>();

  for (const plugin of plugins) {
    const pluginName = String(plugin?.name || '').trim();
    const pluginCategory = String(plugin?.category || '').trim() || undefined;
    const sourceRaw = String(plugin?.source || '').trim();
    if (!sourceRaw) continue;
    const pluginRoot = resolvePluginRoot(sourceRaw, marketplaceDir, options.pluginsRoot);
    if (!fs.existsSync(pluginRoot)) continue;

    const commandSpecs = buildCommandSpecs(pluginRoot, plugin?.commands || []);
    const skillSpecs = buildSkillSpecs(pluginRoot, plugin?.skills || [], pluginName);
    for (const skill of skillSpecs) {
      if (skillIds.has(skill.id)) continue;
      skillIds.add(skill.id);
      skills.push(skill);
    }
    const skillIdsForPlugin = skillSpecs.map((skill) => skill.id);

    const agentPaths = Array.isArray(plugin?.agents) ? plugin!.agents! : [];
    for (const agentPath of agentPaths) {
      const resolved = resolveMarkdownPath(pluginRoot, agentPath);
      if (!resolved || !fs.existsSync(resolved)) continue;
      const meta = readMarkdownMeta(resolved);
      const id = deriveId(resolved);
      const agent: AgentSpec = {
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

function resolvePluginRoot(source: string, marketplaceDir: string, pluginsRoot?: string): string {
  if (path.isAbsolute(source)) return source;
  if (pluginsRoot && pluginsRoot.trim()) {
    return path.resolve(pluginsRoot, source);
  }
  return path.resolve(marketplaceDir, source);
}

function buildCommandSpecs(root: string, entries: string[]): CommandSpec[] {
  const specs: CommandSpec[] = [];
  for (const entry of entries || []) {
    const resolved = resolveMarkdownPath(root, entry);
    if (!resolved || !fs.existsSync(resolved)) continue;
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

function buildSkillSpecs(root: string, entries: string[], plugin?: string): SkillSpec[] {
  const specs: SkillSpec[] = [];
  for (const entry of entries || []) {
    const resolved = resolveMarkdownPath(root, entry);
    if (!resolved || !fs.existsSync(resolved)) continue;
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

function resolveMarkdownPath(root: string, rawPath: string): string {
  if (!rawPath) return '';
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) return trimmed;
  let resolved = path.resolve(root, trimmed);
  if (fs.existsSync(resolved)) return resolved;
  if (!path.extname(resolved)) {
    const withMd = `${resolved}.md`;
    if (fs.existsSync(withMd)) return withMd;
    const withSkill = path.join(resolved, 'SKILL.md');
    if (fs.existsSync(withSkill)) return withSkill;
    const withIndex = path.join(resolved, 'index.md');
    if (fs.existsSync(withIndex)) return withIndex;
  }
  return resolved;
}

function readMarkdownMeta(filePath: string): { title: string; description: string } {
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
  } catch {
    return { title: '', description: '' };
  }
}

function deriveId(resolvedPath: string): string {
  const base = path.basename(resolvedPath);
  const lower = base.toLowerCase();
  let raw = '';
  if (lower === 'skill.md' || lower === 'index.md') {
    raw = path.basename(path.dirname(resolvedPath));
  } else {
    raw = path.basename(resolvedPath, path.extname(resolvedPath));
  }
  return slugify(raw);
}

function slugify(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
