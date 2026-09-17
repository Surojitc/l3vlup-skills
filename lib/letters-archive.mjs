// Where retained originals and extracted text are allowed to live.
//
// This gate belongs to the local-private mode alone. That mode keeps bytes,
// so it needs a disk that will not leak them: git never, an unencrypted
// volume never. Six checks, in order, each with its own refusal, because
// "it did not run" is only useful if it says which condition failed.
//
// The default mode, ephemeral-sec, retains nothing and does not come here.
// The public pipeline therefore works with no archive at all, which is the
// point: the Mac mini can be permanently offline and nothing stops.
//
// The encryption probe is platform work and is injectable, so the tests can
// exercise every refusal without a disk. On Linux it asks whether the mount's
// backing device is a dm-crypt mapping. On macOS it is not written yet, and
// says so. A probe that cannot tell is a refusal, never a pass.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export const ARCHIVE_ENV = 'LETTERS_ARCHIVE_ROOT';

/** Directories that are scratch space on any machine, and on this one in particular. */
const EPHEMERAL = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/dev/shm', '/run', tmpdir()];

const within = (child, parent) => {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Does the volume holding this path encrypt what is written to it? */
export function probeEncryption(root, { platform = process.platform, run = execFileSync } = {}) {
  try {
    if (platform === 'darwin') {
      // Deliberately not implemented yet. The downstream private archive has
      // not been commissioned, and a probe written now would be untested
      // against the volume it is meant to check. Until it exists, local-private
      // refuses on macOS rather than trusting an unverified guess.
      return { encrypted: null, evidence: 'the macOS volume probe is not built yet; local-private is not commissioned' };
    }
    if (platform === 'linux') {
      const source = run('findmnt', ['-no', 'SOURCE', '--target', root], { encoding: 'utf8', timeout: 10_000 }).trim();
      if (!source) return { encrypted: null, evidence: 'the mount holding the path could not be identified' };
      const type = run('lsblk', ['-no', 'TYPE', source], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[0];
      if (type === 'crypt') return { encrypted: true, evidence: `${source} is a dm-crypt mapping` };
      return { encrypted: false, evidence: `${source} is a ${type || 'plain'} device, not a dm-crypt mapping` };
    }
    return { encrypted: null, evidence: `no encryption probe for ${platform}` };
  } catch (err) {
    return { encrypted: null, evidence: `the encryption probe failed: ${err.message}` };
  }
}

/**
 * The archive root, or the reason there is not one.
 *
 * Never throws: the caller prints the refusal and stops. `ok` is true only
 * when every check passed, so a caller that forgets to look at it still
 * cannot get a path it should not write to.
 */
export function resolveArchive({
  env = process.env,
  repoRoot,
  platform = process.platform,
  probe = probeEncryption,
  exists = existsSync,
  stat = statSync,
} = {}) {
  const checks = [];
  const pass = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => {
    checks.push({ name, ok: false, detail });
    return { ok: false, root: null, checks, refusal: `${name}: ${detail}` };
  };

  const raw = env[ARCHIVE_ENV];
  if (!raw || !raw.trim()) return fail('archive root set', `${ARCHIVE_ENV} is not set; the retrieval writes nothing without an archive to write to`);
  pass('archive root set', `${ARCHIVE_ENV} is set`);

  if (!isAbsolute(raw)) return fail('archive root absolute', `${raw} is not an absolute path`);
  const root = resolve(raw);
  pass('archive root absolute', root);

  if (!exists(root)) return fail('archive root exists', `${root} does not exist; mount the volume first`);
  if (!stat(root).isDirectory()) return fail('archive root exists', `${root} is not a directory`);
  pass('archive root exists', 'the directory is present');

  if (repoRoot && within(root, repoRoot)) return fail('archive outside the repository', `${root} is inside ${resolve(repoRoot)}; document bytes must never sit where they could be staged`);
  pass('archive outside the repository', repoRoot ? `outside ${resolve(repoRoot)}` : 'no repository root given to compare against');

  const ephemeral = EPHEMERAL.find((d) => d && within(root, d));
  if (ephemeral) return fail('archive is not scratch space', `${root} is under ${ephemeral}, which is temporary; the archive is permanent storage, not a container's disk`);
  pass('archive is not scratch space', 'not under a temporary directory');

  const enc = probe(root, { platform });
  if (enc.encrypted !== true) return fail('archive volume is encrypted', `${enc.evidence}. Confirmed encryption is required before any document is written`);
  pass('archive volume is encrypted', enc.evidence);

  return { ok: true, root, checks, refusal: null };
}

/** Where each kind of output belongs under the archive root. */
export function archivePaths(root, hash) {
  return {
    original: `${root}/originals/${hash}`,
    text: `${root}/text/${hash}.txt`,
    structured: `${root}/structured/${hash}.json`,
    manifest: `${root}/manifest.json`,
    report: `${root}/review/report.md`,
  };
}
