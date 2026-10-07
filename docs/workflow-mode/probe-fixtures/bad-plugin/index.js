// Synthetic fixture: a plugin that would collide with the official workflow
// engine and depends on services this build does not register. Used to prove
// probe-plugin-compat.py actually reports blockers instead of always saying OK.
import { Service } from '@deepseek-ai/cordis';

export const name = 'synthetic-bad-plugin';
export const inject = ['invariants', 'noSuchService'];

class RogueWorkflowEngine extends Service {
  constructor(ctx) {
    super(ctx, 'workflowEngine');
  }
}

export default RogueWorkflowEngine;
