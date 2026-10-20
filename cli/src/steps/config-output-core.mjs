// Internal staging algorithm. Production callers must use config-output.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Staging protects against preparation failures, not multi-file crash atomicity.
// io is injectable for deterministic filesystem-failure tests.
export function publishConfigOutputs(outputs, io = fs) {
  const staged = [];
  let published = 0;
  const snapshot = file => {
    try {
      const stat = io.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('unsupported target');
      return { bytes: io.readFileSync(file), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, nlink: stat.nlink };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const unchanged = entry => {
    const current = snapshot(entry.file);
    if (Boolean(current) !== Boolean(entry.original) || (current &&
        (!current.bytes.equals(entry.original.bytes) || ['mode', 'dev', 'ino', 'uid', 'gid', 'nlink'].some(key => current[key] !== entry.original[key])))) throw Error('target changed');
  };
  let failure;
  try {
    const seen = new Set();
    for (const output of outputs) {
      const file = path.resolve(output.file);
      const key = process.platform === 'win32' ? file.toLowerCase() : file;
      if (seen.has(key)) throw Error('duplicate target');
      seen.add(key);
      const original = snapshot(file);
      const temp = path.join(path.dirname(file), '.caw-stage-' + crypto.randomUUID());
      const fd = io.openSync(temp, 'wx', 0o600);
      const entry = { file, temp, original }; staged.push(entry);
      try { io.writeFileSync(fd, output.content); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      const bytes = io.readFileSync(temp);
      if (!bytes.equals(Buffer.from(output.content))) throw Error('staged bytes differ');
      if (output.verify) output.verify(temp);
      io.chmodSync(temp, output.mode ?? original?.mode ?? (0o666 & ~process.umask()));
    }
    // Check every target before the first replacement, then again per file.
    for (const entry of staged) unchanged(entry);
    for (const entry of staged) {
      unchanged(entry);
      io.renameSync(entry.temp, entry.file);
      entry.temp = null;
      published++;
    }
  } catch { failure = true; }
  let cleanupFailed = false;
  for (const entry of staged) if (entry.temp) {
    try { io.unlinkSync(entry.temp); } catch (error) { if (error.code !== 'ENOENT') cleanupFailed = true; }
  }
  if (failure || cleanupFailed) throw new Error(
    `Configuration publication failed; ${published} file(s) replaced. Installation incomplete; do not start services. Review files before retrying.` +
    (cleanupFailed ? ' Some private staging files could not be removed.' : ''));
}
