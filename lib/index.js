/**
 * Host shim.
 *
 * Three host facts drive this file. All three were read out of the installed
 * code after a real boot failure, not assumed.
 *
 * 1. `@deepseek-ai/dsh-tools` is reachable from a profile plugin through the
 *    host's own resolution path -- official and third-party plugins alike write
 *    `import { defineTool } from '@deepseek-ai/dsh-tools'`. It must NOT be
 *    declared as a dependency, because a *physical copy* in the profile is what
 *    broke this deployment: its tool-dispatcher Symbol differs from the host
 *    bundle's, so every tool call read `undefined.prepare` and every turn failed.
 *
 * 2. `defineTool` is NOT an identity function. It captures `execute`,
 *    `finalizeContent`, `projectContent`, `output.render`, `presentCall` and
 *    friends and returns "a registry-ready definition". Handing the registry a
 *    raw object would register something the host never validated, so when the
 *    host copy cannot be reached the tool surface stays OFF rather than faked.
 *
 * 3. A non-workbench entry that does not activate is a FATAL startup error in
 *    `dsh-app-boot`. So the import below is dynamic and guarded: this module
 *    ALWAYS loads, whatever the host provides.
 */
import { apply as applyCore } from '../src/plugin.js';

export {
  name,
  inject,
  DEFAULT_CONFIG_PATH,
  resolveConfig,
  buildNodePrompt,
  buildAgentSpawn,
  readContext,
  TOOL_NAME,
  LIBRARY_TOOL_NAME,
} from '../src/plugin.js';

const HOST_TOOLS_PACKAGE = '@deepseek-ai/dsh-tools';

/** Resolved once per module instance. `null` means "unreachable: stay off". */
let hostDefineTool = null;
try {
  const hostTools = await import(HOST_TOOLS_PACKAGE);
  if (typeof hostTools.defineTool === 'function') hostDefineTool = hostTools.defineTool;
} catch {
  // Not resolvable in this deployment. Registration is skipped; a missing tool
  // is strictly better than one the host never accepted, and neither may stop
  // the plugin from activating.
}

/**
 * Resolve the real `defineTool`, or `null`.
 *
 * `explicit` is the test seam and an explicit injection point; it wins so a test
 * can drive the registration path without the host package. Returns `null` -- not
 * an identity function -- when no real implementation exists.
 */
export function resolveDefineTool(ctx, explicit) {
  if (typeof explicit === 'function') return explicit;
  if (hostDefineTool) return hostDefineTool;
  const fromContext = ctx && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get('defineTool') : undefined;
  return typeof fromContext === 'function' ? fromContext : null;
}

export function apply(ctx, options) {
  const opts = options && typeof options === 'object' ? options : {};
  return applyCore(ctx, { ...opts, defineTool: resolveDefineTool(ctx, opts.defineTool) });
}
