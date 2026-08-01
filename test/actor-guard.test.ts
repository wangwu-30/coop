import { describe, it, expect } from 'vitest';
import { normalizeActorWithReason } from '../scripts/actor-guard.mjs';

describe('actor guard', () => {
  it('normalizes generic actor for claim/update/done style events', () => {
    const taskId = 'task-20260311-1606-worker1-generic-actor-backfill-and-guard';

    const claim = normalizeActorWithReason({ rawActor: 'coop-worker', assignee: 'coop-worker-1', taskId });
    expect(claim.actor).toBe('coop-worker-1');
    expect(claim.reason).toBe('generic_actor_fallback');

    const update = normalizeActorWithReason({ rawActor: '', assignee: 'coop-worker-1', taskId });
    expect(update.actor).toBe('coop-worker-1');
    expect(update.reason).toBe('empty_actor_fallback');

    const done = normalizeActorWithReason({ rawActor: 'observer-pm', assignee: 'coop-worker-1', taskId });
    expect(done.actor).toBe('coop-worker-1');
    expect(done.reason).toBe('reject_non_worker_actor');
    expect(done.guard_action).toBe('reject_to_fallback');
  });
});
