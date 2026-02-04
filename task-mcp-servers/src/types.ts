export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  title: string;
  details: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  runId: string;
  sessionId: string;
  userMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInput {
  title: string;
  details?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  runId?: string;
  sessionId?: string;
  userMessageId?: string;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  tag?: string;
  includeDone?: boolean;
  limit?: number;
  sessionId?: string;
  runId?: string;
  allSessions?: boolean;
  allRuns?: boolean;
}

export interface ClearTasksOptions {
  mode?: 'done' | 'all';
  sessionId?: string;
  runId?: string;
  allSessions?: boolean;
  allRuns?: boolean;
}
