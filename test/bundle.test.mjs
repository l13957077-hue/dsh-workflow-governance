import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const read = (rel) => readFileSync(join(PKG, rel), 'utf8');

/** Drop comments so a prose mention of a package name never trips a guard. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
    .join('\n');
}

/**
 * Safety contract for the installable bundle.
 *
 * A physical copy of @deepseek-ai/dsh-tools inside a profile broke this
 * deployment: its tool-dispatcher Symbol differs from the host bundle's, so
 * every tool call read `undefined.prepare` and every turn failed. These tests
 * pin the properties that keep this package from ever causing that again.
 */

test('SAFETY: only the shim may reach the host package, and only through ONE guarded dynamic import', () => {
  // The library code must stay completely free of the host package.
  for (const rel of ['src/plugin.js', 'src/engine-adapter.js', 'src/config.js', 'src/observe.js', 'src/contract.js', 'src/graph-run.js', 'src/library.js', 'src/diagram.js', 'src/artifacts.js', 'src/matcher.js', 'src/gate.js', 'src/deadlock.js']) {
    const code = stripComments(read(rel));
    assert.ok(!/@deepseek-ai\//.test(code), `${rel} must not reference an @deepseek-ai package at all`);
  }

  // The shim is allowed exactly one, because `defineTool` is not an identity
  // function and cannot be faked (see lib/index.js). It must stay:
  //   - dynamic, so an unresolvable package cannot stop the module loading
  //   - inside try/catch, so it cannot fail activation
  //   - the ONLY reference, so nothing else can drag the package in
  const shim = stripComments(read('lib/index.js'));
  assert.ok(
    !/(^|\s)(import|export)\b[^\n]*from\s*['"]@deepseek-ai\//.test(shim),
    'the shim must not statically import an @deepseek-ai package',
  );
  assert.ok(!/require\(\s*['"]@deepseek-ai\//.test(shim), 'the shim must not require an @deepseek-ai package');
  const dynamic = shim.match(/import\(\s*HOST_TOOLS_PACKAGE\s*\)/g) ?? [];
  assert.equal(dynamic.length, 1, `exactly one dynamic import, found ${dynamic.length}`);
  assert.ok(!/import\(\s*['"]/.test(shim), 'the specifier must not be inlined as a literal');
  assert.match(shim, /try\s*\{[\s\S]*?await import\(HOST_TOOLS_PACKAGE\)[\s\S]*?\}\s*catch/, 'the dynamic import must sit inside try/catch');
  assert.match(shim, /const HOST_TOOLS_PACKAGE = '@deepseek-ai\/dsh-tools'/, 'the specifier is a named constant');
  const mentions = shim.match(/@deepseek-ai\/dsh-tools/g) ?? [];
  assert.equal(mentions.length, 1, `the package name must appear exactly once, in that constant; found ${mentions.length}`);
});

test('SAFETY: package.json declares no dependencies at all', () => {
  const manifest = JSON.parse(read('package.json'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    const entries = manifest[field] ?? {};
    assert.deepEqual(Object.keys(entries), [], `${field} must be empty so the installer materialises nothing`);
  }
});

test('SAFETY: the bundle patch is additive only -- it disables nothing', () => {
  const patch = read('cordis.patch.yml');
  const code = patch
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.ok(!/disabled\s*:/.test(code), 'the patch must never disable a native row');
  assert.ok(!/remove\s*:/.test(code), 'the patch must never remove a native row');
  assert.ok(/-\s*insert\s*:/.test(code), 'the patch inserts its own row');
  // Exactly one inserted row, and it is this package.
  const ids = code.match(/^\s*-\s*id\s*:/gm) ?? [];
  assert.equal(ids.length, 1, 'exactly one row is inserted');
  assert.match(code, /name:\s*'dsh-workflow-governance'/);
  assert.ok(!/dsh-workflow['"]/.test(code.replace(/dsh-workflow-governance/g, '')), 'it must never insert the official engine');
});

test('the shipped Workflow preset is a real, self-consistent entry (R16)', () => {
  // R16's deliverable is a preset directory: DSH 0.2.0-rc.2 lists
  // <DSH_HOME>/.agent-presets/<id>/ in the new-session preset selector, which is
  // the "entry that is not a normal chat". Both files must be shippable as they
  // stand, so their structure is pinned here rather than discovered at install time.
  const meta = read('presets/workflow/preset.yml');
  assert.match(meta, /^name:\s*\S+/m, 'a preset needs a name, or the selector shows nothing');
  assert.match(meta, /^description:\s*\S+/m, 'and a description, which is how it is told apart');
  assert.match(meta, /^order:\s*\d+/m, 'and an order');

  const composition = read('presets/workflow/agent.cordis.yml');
  const code = composition
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  // Every row must name a package that really ships on this machine: the whole
  // point of a directory preset is that it is a loader row array, and an invented
  // package name makes the session fail to start.
  const names = [...code.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 10, `expected the standard composition, found ${names.length} names`);
  for (const name of names) {
    assert.ok(
      name.startsWith('@deepseek-ai/') || name === 'cordis:group' || name === 'dsh-workflow-governance',
      `row "${name}" is neither an official package, a group, nor this package`,
    );
  }
  // This layer is registered at ROOT level (column 0), because it reads root
  // services; inside the delegation group it would be behind the engine's isolate.
  assert.match(code, /^-\s*id:\s*workflow-governance$/m, 'the governance row must sit at root level');
  assert.match(code, /^\s{2}name:\s*dsh-workflow-governance$/m);

  // The persona is the actual difference from a normal chat, so it has to teach the
  // mechanism rather than greet the user.
  for (const needle of ['contract_workflow', 'when', 'find', 'observed', 'gate_request', 'inferred']) {
    assert.ok(composition.includes(needle), `the persona must mention ${needle}`);
  }
  assert.ok(
    /不绕过契约|不要试图绕过/.test(composition),
    'and it must forbid bypassing a contract, which is the one rule this mode exists for',
  );
});

test('the bundle entry loads with no host packages present and exposes the plugin surface', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.name, 'workflow-governance');
  // SAFETY: must stay empty. In this cordis every inject key is a REQUIRED
  // service, and in dsh-app-boot a non-workbench entry that stays pending is a
  // FATAL startup error -- which is exactly how this plugin once stopped DSH from
  // booting by asking for workflowEngine in a profile that has no engine.
  assert.deepEqual([...mod.inject], []);
  assert.equal(typeof mod.resolveDefineTool, 'function');
});

test('resolveDefineTool returns the real one, or null -- never an identity fake', async () => {
  const { resolveDefineTool } = await import('../lib/index.js');
  const explicit = () => 'explicit';
  const fromCtx = () => 'ctx';
  assert.equal(resolveDefineTool({ get: () => fromCtx }, explicit), explicit, 'an explicit injection wins');
  assert.equal(resolveDefineTool({ get: () => fromCtx }, undefined), fromCtx, 'then a context that provides one');
  // `defineTool` validates and wraps a definition, so faking it with identity
  // would register something the host never accepted. The honest answer when no
  // real implementation exists is null, and the caller then registers nothing.
  assert.equal(resolveDefineTool({ get: () => undefined }, undefined), null);
  assert.equal(resolveDefineTool({}, undefined), null);
  assert.equal(resolveDefineTool(null, undefined), null);
  assert.equal(resolveDefineTool(undefined, undefined), null);
});

test('with no reachable defineTool nothing is registered; with an injected double the core runs', async () => {
  const { apply } = await import('../lib/index.js');
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition) {
        registered.push(definition);
        return undefined;
      },
    },
    // The delegation service, in the shape the host's own caller uses.
    subagents: {
      start: async () => ({
        id: 'run-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"text":"ok"}' }] }),
        dispose: async () => {},
      }),
    },
  };
  const dir = await import('node:fs');
  const os = await import('node:os');
  const tmp = dir.mkdtempSync(join(os.tmpdir(), 'wfg-bundle-'));
  const configPath = join(tmp, 'config.json');
  dir.writeFileSync(configPath, JSON.stringify({ switches: { contracts: true } }), 'utf8');
  try {
    // In this bare node there is no host package to reach, so the plugin must
    // NOT invent a definition -- it registers nothing and still does not throw.
    apply(ctx, { configPath });
    assert.equal(registered.length, 0, 'no real defineTool means no registration');

    // The documented test seam: an explicit double exercises the real path.
    apply(ctx, { configPath, defineTool: (definition) => definition });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'contract_workflow');
    const result = await registered[0].execute(
      { workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } },
      { agent: { id: 'parent' } },
    );
    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.outputs.a, { text: 'ok' }, 'the JSON answer became the node payload');
  } finally {
    dir.rmSync(tmp, { recursive: true, force: true });
  }
});
