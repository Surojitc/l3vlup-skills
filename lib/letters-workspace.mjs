// Where a run is allowed to put bytes, and how it promises to remove them.
//
// Two modes, and the difference is what survives the run.
//
//   ephemeral-sec   The default, and the whole first-cut production path. It
//                   works on documents the SEC publishes and the approved
//                   selection already names, in a directory made fresh for
//                   this run and deleted at the end of it. Nothing it
//                   downloads or extracts outlives the process, so it needs
//                   no archive, no encryption and no permanent storage, and
//                   it runs the same on a laptop and on a GitHub runner.
//
//   local-private   Optional, and not part of Phase 0. It keeps originals and
//                   extracted text, so it keeps the archive gate: a verified
//                   encrypted volume or it refuses.
//
// The absence of an archive is not an error in the default mode. That is the
// point: the public pipeline has to work with the Mac mini permanently off.

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArchive } from './letters-archive.mjs';

export const MODES = ['ephemeral-sec', 'local-private'];
export const DEFAULT_MODE = 'ephemeral-sec';

/** Only what the SEC publishes, and only over https. */
export const SEC_DOCUMENT = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[^/]+$/;

/**
 * Is this document one the approved selection names?
 *
 * Two independent conditions, because either alone is too weak: the URL has
 * to be a sec.gov filing document, and it has to appear in the selection we
 * agreed. A run cannot reach a document nobody approved by editing a URL.
 */
export function approvedDocument(url, selection) {
  if (!SEC_DOCUMENT.test(url)) return { ok: false, reason: `${url} is not an https www.sec.gov filing document` };
  const hit = (selection || []).find((d) => d.documentUrl === url);
  if (!hit) return { ok: false, reason: `${url} is not in the approved selection` };
  return { ok: true, document: hit };
}

/**
 * A directory for this run alone.
 *
 * mkdtemp makes a fresh one every time, so two runs never share a path and a
 * leftover from a killed run is never mistaken for this run's work.
 */
export function createWorkspace({ prefix = 'letters-run-', base = tmpdir() } = {}) {
  const path = mkdtempSync(join(base, prefix));
  let removed = false;
  return {
    path,
    /** Idempotent: safe from a finally block, a signal handler and both. */
    cleanup() {
      if (removed) return { removed: false, alreadyGone: true };
      rmSync(path, { recursive: true, force: true });
      removed = true;
      return { removed: true, alreadyGone: false };
    },
    /** What is still on disk, for the assertion a run makes about itself. */
    survey() {
      try {
        statSync(path);
      } catch {
        return { exists: false, files: [] };
      }
      const files = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(path);
      return { exists: true, files };
    },
  };
}

/**
 * The mode, the place to work, and the reason there is not one.
 *
 * Never throws. A caller that ignores `ok` gets no path to write to.
 */
export function resolveWorkspace({ mode = DEFAULT_MODE, env = process.env, repoRoot, base = tmpdir() } = {}) {
  if (!MODES.includes(mode)) return { ok: false, mode, refusal: `unknown mode ${mode}; expected one of ${MODES.join(', ')}` };

  if (mode === 'ephemeral-sec') {
    const ws = createWorkspace({ base });
    return {
      ok: true,
      mode,
      workspace: ws,
      root: ws.path,
      retainsBytes: false,
      checks: [
        { name: 'fresh workspace', ok: true, detail: `made for this run at ${ws.path}` },
        { name: 'nothing retained', ok: true, detail: 'originals and extracted text are deleted when the run ends' },
        { name: 'approved SEC documents only', ok: true, detail: 'every URL is checked against the selection before it is fetched' },
      ],
      refusal: null,
    };
  }

  const archive = resolveArchive({ env, repoRoot });
  if (!archive.ok) return { ok: false, mode, workspace: null, root: null, retainsBytes: true, checks: archive.checks, refusal: archive.refusal };
  const ws = createWorkspace({ base });
  return {
    ok: true,
    mode,
    workspace: ws,
    root: archive.root,
    scratch: ws,
    retainsBytes: true,
    checks: archive.checks,
    refusal: null,
  };
}

/**
 * Cleanup that survives the ways a run ends.
 *
 * A finally block covers the ordinary paths, including a thrown parser. The
 * signal handlers cover an interrupt and a terminate, which is what a job
 * cancellation sends first. Neither covers a machine that disappears: if the
 * host is destroyed there is no code left to run, and what protects the
 * bytes then is that the runner itself is discarded.
 */
export function onExitCleanup(workspace, { on = process.on.bind(process), signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] } = {}) {
  const handlers = [];
  for (const signal of signals) {
    const handler = () => {
      workspace.cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    on(signal, handler);
    handlers.push([signal, handler]);
  }
  return handlers;
}

/**
 * Run something in a workspace and leave nothing behind, whatever happened.
 *
 * The finally block covers every ordinary ending: a clean return, a thrown
 * fetch refusal, a parser that raised, a write that was interrupted. The
 * survey either side of the cleanup is the run's assertion about itself, so
 * a failure to delete is reported rather than assumed away. What this cannot
 * cover is the machine vanishing mid-run; there the ephemeral host is the
 * protection, not this code.
 */
export async function withWorkspace(workspace, fn) {
  let value = null;
  let error = null;
  let cleanup = null;
  try {
    value = await fn(workspace);
  } catch (err) {
    error = err;
  } finally {
    const before = workspace.survey();
    const removed = workspace.cleanup();
    const after = workspace.survey();
    cleanup = {
      scratchFilesAtEnd: before.files.length,
      removed: removed.removed,
      remainingFiles: after.files.length,
      workspaceExists: after.exists,
      clean: !after.exists && after.files.length === 0,
    };
  }
  return { value, error, cleanup };
}
