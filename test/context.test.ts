import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCoopContext, resolveCoopRoot } from '../src/context.js';

describe('coop context', () => {
  it('uses the working directory instead of an implicit home repository', () => {
    const root = resolveCoopRoot({ cwd: '/tmp/business-repo' });
    expect(root).toBe(path.resolve('/tmp/business-repo'));
  });

  it('derives every canonical path from one root', () => {
    const context = createCoopContext({ rootDir: '/tmp/coop-state' });
    expect(context.tasksDir).toBe(path.resolve('/tmp/coop-state/cooperation/tasks'));
    expect(context.logsDir).toBe(path.resolve('/tmp/coop-state/logs'));
    expect(context.messageReceiptsDir).toBe(path.resolve('/tmp/coop-state/cooperation/message-receipts'));
    expect(context.observerStateDir).toBe(path.resolve('/tmp/coop-state/coop-min/state'));
  });
});
