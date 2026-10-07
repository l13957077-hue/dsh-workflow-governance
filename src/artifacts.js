/**
 * R11: persist a finished run -- its result, its topology and its diagram.
 *
 * The official workflow capability writes four log-only session records carrying
 * identity and status and nothing else; it produces no result file and no diagram
 * artifact. This is the other half of R11: after a run, the layer that already
 * knows the declared graph and the run verdict writes both to disk.
 *
 * Design rules, all inherited from the rest of this layer:
 *   - the root is CALLER-provided, so nothing here invents a machine-global path;
 *   - writes are atomic (temp + rename), so a crash cannot leave half a file;
 *   - a name from outside is sanitised to a safe stem, because it reaches a
 *     filename and names here may be arbitrary text (including CJK);
 *   - pruning is bounded and deterministic;
 *   - best effort at the edges: a failed artifact must never fail a run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SUFFIX = '.json';
const MAX_STEM = 48;

/** A filename-safe stem. Never empty, never a path fragment. */
export function artifactStem(name) {
  const raw = typeof name === 'string' ? name : '';
  const kept = raw
    .replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_STEM);
  return kept === '' ? 'workflow' : kept;
}

/** `2026-10-07T01-02-03-456Z-name.json` -- sorts chronologically as text. */
export function artifactFileName(at, name) {
  const stamp = new Date(Number.isFinite(at) ? at : 0).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${artifactStem(name)}${SUFFIX}`;
}

export function artifactPath(root, at, name) {
  return join(root, artifactFileName(at, name));
}

/** Every artifact, oldest first (the filename leads with a fixed-width stamp). */
export function listRunArtifacts(root) {
  try {
    if (typeof root !== 'string' || root === '' || !existsSync(root)) return [];
    return readdirSync(root)
      .filter((entry) => entry.endsWith(SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write one run artifact and prune the directory to `maxFiles`.
 *
 * @returns `{ ok: true, path, pruned }` or `{ ok: false, code, message }` -- never
 * a throw, because this runs at the end of a run and must not change its verdict.
 */
export function writeRunArtifact({ root, name, graph, result, diagram, at, maxFiles = 50 } = {}) {
  try {
    if (typeof root !== 'string' || root === '') return { ok: false, code: 'NO_ROOT', message: 'an artifact root is required' };
    const when = Number.isFinite(at) ? at : Date.now();
    const file = artifactPath(root, when, name);
    const payload = {
      formatVersion: 1,
      at: when,
      name: typeof name === 'string' ? name : null,
      // The topology, verbatim: this is R11's "full set of flow diagrams".
      graph: {
        nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
        edges: Array.isArray(graph?.edges) ? graph.edges : [],
      },
      // R3's rendering, so an artifact is readable on its own.
      diagram: typeof diagram === 'string' ? diagram : null,
      // The verdict, including per-node attempts and any contract violations.
      result: result === undefined ? null : result,
    };
    mkdirSync(root, { recursive: true });
    const tmp = `${file}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, path: file, pruned: pruneRunArtifacts(root, maxFiles) };
  } catch (error) {
    return { ok: false, code: 'WRITE_FAILED', message: String(error && error.message ? error.message : error) };
  }
}

/** Keep the newest `maxFiles`; delete the rest. Returns the names removed. */
export function pruneRunArtifacts(root, maxFiles = 50) {
  const removed = [];
  try {
    const limit = Number.isFinite(maxFiles) ? Math.max(0, Math.floor(maxFiles)) : 50;
    const files = listRunArtifacts(root);
    for (const stale of files.slice(0, Math.max(0, files.length - limit))) {
      try {
        rmSync(join(root, stale));
        removed.push(stale);
      } catch {
        // A file that cannot be removed is not worth failing the run over.
      }
    }
  } catch {
    // Listing failed; nothing to prune.
  }
  return removed;
}

/** Read one artifact back, for a caller that wants to show it. Total. */
export function readRunArtifact(root, fileName) {
  try {
    if (typeof root !== 'string' || typeof fileName !== 'string' || fileName === '') return null;
    // Confinement: only a bare filename inside the root is acceptable.
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null;
    return JSON.parse(readFileSync(join(root, fileName), 'utf8'));
  } catch {
    return null;
  }
}
