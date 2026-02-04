export type ChangeAction = 'write' | 'append' | 'delete' | 'move' | 'mkdir';

export interface ChangeRecord {
  id: string;
  path: string;
  action: ChangeAction;
  bytes: number;
  sha256: string;
  sessionId: string;
  runId: string;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
}
