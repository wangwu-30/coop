const KNOWN_WORKERS = ['coop-worker-1', 'coop-worker-2', 'coop-worker-3'];
const WORKER_PATTERN = /^coop-worker-[1-9]\d*$/;

function inferWorkerFromTaskId(taskId) {
  if (typeof taskId !== 'string') return null;
  const match = taskId.match(/worker[-_]?([1-9]\d*)/i);
  if (!match) return null;
  return `coop-worker-${match[1]}`;
}

function toKnownWorker(candidate) {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!WORKER_PATTERN.test(value)) return null;
  return KNOWN_WORKERS.includes(value) ? value : null;
}

function normalizeActorWithReason({ rawActor, assignee, taskId, fallback = 'coop-worker-1' }) {
  const actor = typeof rawActor === 'string' ? rawActor.trim() : '';
  const assigneeWorker = toKnownWorker(assignee);
  const inferredWorker = toKnownWorker(inferWorkerFromTaskId(taskId));

  if (toKnownWorker(actor)) {
    return {
      actor,
      raw_actor: actor,
      reason: 'whitelist_pass',
      guard_action: 'accept'
    };
  }

  let normalized = assigneeWorker ?? inferredWorker ?? fallback;
  let reason = 'non_whitelist_actor';
  let guard_action = 'normalize';

  if (actor === 'coop-worker') {
    reason = normalized === fallback && !assigneeWorker && !inferredWorker
      ? 'generic_actor_fallback_default'
      : 'generic_actor_fallback';
  } else if (!actor) {
    reason = 'empty_actor_fallback';
  } else if (!/^coop-worker/.test(actor)) {
    reason = 'reject_non_worker_actor';
    guard_action = 'reject_to_fallback';
  }

  return {
    actor: normalized,
    raw_actor: actor || null,
    reason,
    guard_action
  };
}

function normalizeEventActor(event, options = {}) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const taskId = event?.task_id ?? payload.task_id ?? null;
  const assignee = payload.assignee ?? event?.assignee ?? null;
  return normalizeActorWithReason({ rawActor: event?.actor, assignee, taskId, fallback: options.fallback });
}

export { KNOWN_WORKERS, WORKER_PATTERN, inferWorkerFromTaskId, toKnownWorker, normalizeActorWithReason, normalizeEventActor };
