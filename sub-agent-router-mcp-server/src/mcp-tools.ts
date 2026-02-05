import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServerConfig } from './types.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  serverId: string;
  serverName: string;
  rawToolName: string;
}

export interface McpToolSession {
  tools: McpToolDefinition[];
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

type ToolEntry = {
  client: Client;
  serverId: string;
  serverName: string;
  rawToolName: string;
};

export async function createMcpToolSession(options: {
  servers: McpServerConfig[];
  allowPrefixes?: string[];
  clientName?: string;
  clientVersion?: string;
}): Promise<McpToolSession | null> {
  const servers = Array.isArray(options.servers) ? options.servers.filter((s) => s.enabled) : [];
  if (servers.length === 0) return null;

  const allowPrefixes = Array.isArray(options.allowPrefixes)
    ? options.allowPrefixes.map((p) => String(p || '').trim()).filter(Boolean)
    : [];

  const clients: Client[] = [];
  const toolMap = new Map<string, ToolEntry>();
  const tools: McpToolDefinition[] = [];

  for (const server of servers) {
    const transport = createTransport(server);
    if (!transport) continue;

    const client = new Client({
      name: options.clientName || 'sub_agent_router',
      version: options.clientVersion || '0.2.0',
    });

    try {
      await client.connect(transport);
      clients.push(client);
      const list = await client.listTools();
      const prefix = `mcp_${normalizeMcpName(server.name)}_`;
      for (const tool of list.tools || []) {
        const rawName = String(tool.name || '').trim();
        if (!rawName) continue;
        const prefixedName = rawName.startsWith(prefix) ? rawName : `${prefix}${rawName}`;
        if (allowPrefixes.length > 0 && !allowPrefixes.some((p) => prefixedName.startsWith(p))) {
          continue;
        }
        if (toolMap.has(prefixedName)) {
          continue;
        }
        toolMap.set(prefixedName, {
          client,
          serverId: server.id,
          serverName: server.name,
          rawToolName: rawName,
        });
        tools.push({
          name: prefixedName,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          serverId: server.id,
          serverName: server.name,
          rawToolName: rawName,
        });
      }
    } catch {
      try {
        await client.close();
      } catch {}
    }
  }

  if (tools.length === 0) {
    for (const client of clients) {
      try {
        await client.close();
      } catch {}
    }
    return null;
  }

  const callTool = async (toolName: string, args: Record<string, unknown>) => {
    const entry = toolMap.get(toolName);
    if (!entry) {
      return JSON.stringify({
        ok: false,
        error: `Tool not found: ${toolName}`,
      });
    }
    try {
      const result = await entry.client.callTool({
        name: entry.rawToolName,
        arguments: args,
      });
      const contentText = extractToolText(result);
      return JSON.stringify({
        ok: !result.isError,
        server_id: entry.serverId,
        server_name: entry.serverName,
        tool: entry.rawToolName,
        content: contentText,
        structured: result.structuredContent ?? null,
        is_error: result.isError || false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        ok: false,
        server_id: entry.serverId,
        server_name: entry.serverName,
        tool: entry.rawToolName,
        error: message,
      });
    }
  };

  const close = async () => {
    for (const client of clients) {
      try {
        await client.close();
      } catch {}
    }
  };

  return { tools, callTool, close };
}

function createTransport(server: McpServerConfig) {
  const transport = String(server.transport || '').trim().toLowerCase();
  if (transport === 'stdio') {
    const command = cleanToken(server.command);
    if (!command) return null;
    return new StdioClientTransport({
      command,
      args: (Array.isArray(server.args) ? server.args : []).map(cleanToken).filter(Boolean),
      stderr: 'pipe',
    });
  }
  const endpointUrl = cleanToken(server.endpointUrl || server.command || '');
  if (!endpointUrl) return null;
  const headers = safeParseHeaders(server.headersJson);
  const opts =
    headers && Object.keys(headers).length > 0
      ? { requestInit: { headers } }
      : undefined;
  try {
    const url = new URL(endpointUrl);
    return new StreamableHTTPClientTransport(url, opts);
  } catch {
    return null;
  }
}

function safeParseHeaders(raw: string): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      headers[String(key)] = String(value ?? '');
    }
    return headers;
  } catch {
    return null;
  }
}

function normalizeMcpName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanToken(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/,+$/g, '')
    .trim();
}

function extractToolText(result: any): string {
  if (result?.structuredContent) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return String(result.structuredContent);
    }
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts: string[] = [];
  for (const entry of content) {
    if (entry?.type === 'text') {
      parts.push(String(entry.text || ''));
    } else {
      try {
        parts.push(JSON.stringify(entry));
      } catch {
        parts.push(String(entry));
      }
    }
  }
  return parts.join('\n').trim();
}
