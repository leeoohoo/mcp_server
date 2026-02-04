import { spawn } from 'child_process';
export function spawnCommand(spec, context, options = {}) {
    if (!Array.isArray(spec.exec) || spec.exec.length === 0 || !spec.exec[0]) {
        throw new Error('Command spec is missing exec');
    }
    const [command, ...args] = spec.exec;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
    const maxOutputBytes = typeof options.maxOutputBytes === 'number' ? options.maxOutputBytes : 1024 * 1024;
    const mcpServers = Array.isArray(context.mcpServers) ? context.mcpServers : [];
    const env = {
        ...process.env,
        ...spec.env,
        SUBAGENT_TASK: context.task,
        SUBAGENT_AGENT_ID: context.agentId || '',
        SUBAGENT_COMMAND_ID: context.commandId || '',
        SUBAGENT_SKILLS: context.skills.join(','),
        SUBAGENT_SESSION_ID: context.sessionId,
        SUBAGENT_RUN_ID: context.runId,
        SUBAGENT_CATEGORY: context.category || '',
        SUBAGENT_QUERY: context.query || '',
        SUBAGENT_MODEL: context.model || '',
        SUBAGENT_CALLER_MODEL: context.callerModel || '',
        SUBAGENT_MCP_ALLOW_PREFIXES: Array.isArray(context.mcpAllowPrefixes) ? context.mcpAllowPrefixes.join(',') : '',
        SUBAGENT_MCP_SERVERS: mcpServers.length > 0 ? JSON.stringify(mcpServers.map(summarizeMcpServer)) : '',
    };
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
        cwd: spec.cwd || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const append = (chunk, target) => {
        const text = chunk.toString('utf8');
        if (target === 'stdout') {
            if (stdout.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stdout.length, 0);
                if (remaining > 0)
                    stdout += text.slice(0, remaining);
                stdoutTruncated = true;
                return;
            }
            stdout += text;
        }
        else {
            if (stderr.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stderr.length, 0);
                if (remaining > 0)
                    stderr += text.slice(0, remaining);
                stderrTruncated = true;
                return;
            }
            stderr += text;
        }
    };
    if (child.stdout) {
        child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    }
    if (child.stderr) {
        child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    }
    const result = new Promise((resolve) => {
        let errorMessage = null;
        let timeout = null;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGTERM');
                }
                catch { }
                setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { }
                }, 2000);
            }, timeoutMs);
        }
        child.on('error', (err) => {
            errorMessage = err?.message || 'spawn error';
        });
        child.on('close', (code, signal) => {
            if (timeout)
                clearTimeout(timeout);
            const finishedAt = new Date().toISOString();
            const durationMs = Date.now() - Date.parse(startedAt);
            resolve({
                stdout,
                stderr,
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null,
                startedAt,
                finishedAt,
                durationMs,
                stdoutTruncated,
                stderrTruncated,
                error: errorMessage,
                timedOut,
            });
        });
    });
    return { child, startedAt, result };
}
function summarizeMcpServer(server) {
    return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        endpoint_url: server.endpointUrl || '',
        headers_json: server.headersJson || '',
    };
}
export async function runCommandWithInput(command, input, env, options = {}) {
    if (!Array.isArray(command) || command.length === 0 || !command[0]) {
        throw new Error('Command is required');
    }
    const [cmd, ...args] = command;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
    const maxOutputBytes = typeof options.maxOutputBytes === 'number' ? options.maxOutputBytes : 1024 * 1024;
    const startedAt = new Date().toISOString();
    const child = spawn(cmd, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let errorMessage = null;
    const append = (chunk, target) => {
        const text = chunk.toString('utf8');
        if (target === 'stdout') {
            if (stdout.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stdout.length, 0);
                if (remaining > 0)
                    stdout += text.slice(0, remaining);
                stdoutTruncated = true;
                return;
            }
            stdout += text;
        }
        else {
            if (stderr.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stderr.length, 0);
                if (remaining > 0)
                    stderr += text.slice(0, remaining);
                stderrTruncated = true;
                return;
            }
            stderr += text;
        }
    };
    if (child.stdout) {
        child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    }
    if (child.stderr) {
        child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    }
    const result = new Promise((resolve) => {
        let timeout = null;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGTERM');
                }
                catch { }
                setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { }
                }, 2000);
            }, timeoutMs);
        }
        child.on('error', (err) => {
            errorMessage = err?.message || 'spawn error';
        });
        child.on('close', (code, signal) => {
            if (timeout)
                clearTimeout(timeout);
            const finishedAt = new Date().toISOString();
            const durationMs = Date.now() - Date.parse(startedAt);
            resolve({
                stdout,
                stderr,
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null,
                startedAt,
                finishedAt,
                durationMs,
                stdoutTruncated,
                stderrTruncated,
                error: errorMessage,
                timedOut,
            });
        });
    });
    if (child.stdin) {
        child.stdin.write(input || '');
        child.stdin.end();
    }
    return await result;
}
export function spawnCommandWithInput(command, input, env, options = {}) {
    if (!Array.isArray(command) || command.length === 0 || !command[0]) {
        throw new Error('Command is required');
    }
    const [cmd, ...args] = command;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
    const maxOutputBytes = typeof options.maxOutputBytes === 'number' ? options.maxOutputBytes : 1024 * 1024;
    const startedAt = new Date().toISOString();
    const child = spawn(cmd, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let errorMessage = null;
    const append = (chunk, target) => {
        const text = chunk.toString('utf8');
        if (target === 'stdout') {
            if (stdout.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stdout.length, 0);
                if (remaining > 0)
                    stdout += text.slice(0, remaining);
                stdoutTruncated = true;
                return;
            }
            stdout += text;
        }
        else {
            if (stderr.length + text.length > maxOutputBytes) {
                const remaining = Math.max(maxOutputBytes - stderr.length, 0);
                if (remaining > 0)
                    stderr += text.slice(0, remaining);
                stderrTruncated = true;
                return;
            }
            stderr += text;
        }
    };
    if (child.stdout) {
        child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    }
    if (child.stderr) {
        child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    }
    const result = new Promise((resolve) => {
        let timeout = null;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGTERM');
                }
                catch { }
                setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { }
                }, 2000);
            }, timeoutMs);
        }
        child.on('error', (err) => {
            errorMessage = err?.message || 'spawn error';
        });
        child.on('close', (code, signal) => {
            if (timeout)
                clearTimeout(timeout);
            const finishedAt = new Date().toISOString();
            const durationMs = Date.now() - Date.parse(startedAt);
            resolve({
                stdout,
                stderr,
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null,
                startedAt,
                finishedAt,
                durationMs,
                stdoutTruncated,
                stderrTruncated,
                error: errorMessage,
                timedOut,
            });
        });
    });
    if (child.stdin) {
        child.stdin.write(input || '');
        child.stdin.end();
    }
    return { child, startedAt, result };
}
