import fs from 'fs';
import path from 'path';
import { ensurePathInsideRoot } from './utils.js';

export interface ApplyPatchResult {
  updated: string[];
  added: string[];
  deleted: string[];
}

type PatchOp =
  | { type: 'update'; path: string; moveTo?: string; hunks: string[] }
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'delete'; path: string };

export function applyPatch({ root, patch, allowWrites }: { root: string; patch: string; allowWrites: boolean }): ApplyPatchResult {
  if (!allowWrites) {
    throw new Error('Writes are disabled.');
  }
  const ops = parsePatch(patch);
  const updated: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  ops.forEach((op) => {
    if (op.type === 'add') {
      const target = ensurePathInsideRoot(root, op.path);
      const content = op.lines.join('\n');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      added.push(op.path);
      return;
    }

    if (op.type === 'delete') {
      const target = ensurePathInsideRoot(root, op.path);
      fs.rmSync(target, { recursive: true, force: true });
      deleted.push(op.path);
      return;
    }

    const target = ensurePathInsideRoot(root, op.path);
    const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const { lines: origLines, eol, endsWithEol } = splitLines(original);
    const nextLines = applyHunks(origLines, op.hunks);
    const output = joinLines(nextLines, eol, endsWithEol);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output, 'utf8');
    if (op.moveTo) {
      const moved = ensurePathInsideRoot(root, op.moveTo);
      fs.mkdirSync(path.dirname(moved), { recursive: true });
      fs.renameSync(target, moved);
      updated.push(op.moveTo);
    } else {
      updated.push(op.path);
    }
  });

  return { updated, added, deleted };
}

function parsePatch(input: string): PatchOp[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const ops: PatchOp[] = [];

  const requireLine = (prefix: string) => {
    const line = lines[i];
    if (!line || !line.startsWith(prefix)) {
      throw new Error(`Invalid patch format at line ${i + 1}: expected ${prefix}`);
    }
    return line.slice(prefix.length).trim();
  };

  if (!lines[i] || !lines[i].startsWith('*** Begin Patch')) {
    throw new Error('Patch must start with "*** Begin Patch"');
  }
  i += 1;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** End Patch')) {
      break;
    }
    if (line.startsWith('*** Update File: ')) {
      const filePath = requireLine('*** Update File: ');
      i += 1;
      let moveTo: string | undefined;
      if (lines[i] && lines[i].startsWith('*** Move to: ')) {
        moveTo = requireLine('*** Move to: ');
        i += 1;
      }
      const hunks: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
        hunks.push(lines[i]);
        i += 1;
      }
      if (lines[i]?.startsWith('*** End Patch')) i += 1;
      ops.push({ type: 'update', path: filePath, moveTo, hunks });
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const filePath = requireLine('*** Add File: ');
      i += 1;
      const addLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
        const raw = lines[i];
        if (raw.startsWith('+')) {
          addLines.push(raw.slice(1));
        }
        i += 1;
      }
      if (lines[i]?.startsWith('*** End Patch')) i += 1;
      ops.push({ type: 'add', path: filePath, lines: addLines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const filePath = requireLine('*** Delete File: ');
      i += 1;
      while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
        i += 1;
      }
      if (lines[i]?.startsWith('*** End Patch')) i += 1;
      ops.push({ type: 'delete', path: filePath });
      continue;
    }
    throw new Error(`Unsupported patch instruction at line ${i + 1}: ${line}`);
  }

  return ops;
}

function splitLines(text: string) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = text.endsWith(eol);
  const rawLines = text.split(/\r?\n/);
  if (endsWithEol && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  return { lines: rawLines, eol, endsWithEol };
}

function joinLines(lines: string[], eol: string, endsWithEol: boolean) {
  const body = lines.join(eol);
  return endsWithEol ? body + eol : body;
}

function applyHunks(original: string[], hunkLines: string[]): string[] {
  const out: string[] = [];
  let pos = 0;
  const hunks = splitHunks(hunkLines);

  for (const hunk of hunks) {
    const expected = hunk
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1));

    const startIdx = expected.length === 0 ? pos : findSequence(original, expected, pos);
    if (startIdx === -1) {
      throw new Error('Patch context not found in file.');
    }

    out.push(...original.slice(pos, startIdx));
    let idx = startIdx;

    for (const line of hunk) {
      if (line.startsWith('@@')) {
        continue;
      }
      if (line.startsWith(' ')) {
        if (original[idx] !== line.slice(1)) {
          throw new Error('Patch context mismatch.');
        }
        out.push(original[idx]);
        idx += 1;
        continue;
      }
      if (line.startsWith('-')) {
        if (original[idx] !== line.slice(1)) {
          throw new Error('Patch removal mismatch.');
        }
        idx += 1;
        continue;
      }
      if (line.startsWith('+')) {
        out.push(line.slice(1));
        continue;
      }
      if (line.startsWith('\\')) {
        continue;
      }
    }

    pos = idx;
  }

  out.push(...original.slice(pos));
  return out;
}

function splitHunks(lines: string[]) {
  const hunks: string[][] = [];
  let current: string[] = [];
  lines.forEach((line) => {
    if (line.startsWith('@@')) {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      current.push(line);
      return;
    }
    current.push(line);
  });
  if (current.length > 0) hunks.push(current);
  return hunks;
}

function findSequence(haystack: string[], needle: string[], start: number) {
  if (needle.length === 0) return start;
  for (let i = start; i <= haystack.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
