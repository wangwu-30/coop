export type CoopMinDecision = 'continue' | 'stop';

export interface CoopMinTaskSummary {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string;
  updated: string;
}

export interface CoopMinSuggestedTask {
  slot: string;
  title: string;
  lane: 'stability' | 'improvement';
  priority: 'low' | 'medium' | 'high' | 'critical';
  recommended: boolean;
  why: string;
  acceptance_criteria: string[];
  suggested_assignee: string;
}

export interface CoopMinObserverSummary {
  schema: 'agent-coop.coop-min.observer-summary.v1';
  generated_at: string;
  actor: string;
  source_commit: string | null;
  worktree_dirty: boolean;
  input_issues: string[];
  counts: {
    open: number;
    in_progress: number;
    blocked: number;
    total: number;
  };
  quality: Record<string, unknown>;
  decision: CoopMinDecision;
  reason: string;
  suggested_tasks: CoopMinSuggestedTask[];
}

export interface CoopMinDispatch {
  schema: 'agent-coop.coop-min.dispatch.v1';
  dispatch_id: string;
  generated_at: string;
  actor: string;
  source_commit: string | null;
  decision: CoopMinDecision;
  reason: string;
  task_count: number;
  tasks: CoopMinSuggestedTask[];
}
