import fs from 'node:fs';
import path from 'node:path';

export function publishConfigOutputs(outputs, io = fs) {
  // chmod does not preserve a protected Windows DACL across replacement.
  // Reject before snapshot reads, stage creation or target mutation.
  if (process.platform === 'win32') {
    throw new Error('Configuration publication is unavailable on Windows until ACL-preserving replacement is implemented. No configuration files were written.');
  }
  // Inspect the whole plan before any write. Resolve parent aliases for absent
  // targets too; reject symlink/non-regular targets and multiply linked files.
  // This is an observed-state check, not protection against concurrent changes.
  try {
    const destinations = new Set();
    const identities = new Set();
    for (const output of outputs) {
      const absolute = path.resolve(output.file);
      const parent = io.realpathSync(path.dirname(absolute));
      const destination = path.join(parent, path.basename(absolute));
      if (destinations.has(destination)) throw new Error('duplicate destination');
      destinations.add(destination);
      let stat;
      try { stat = io.lstatSync(absolute, { bigint: true }); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (stat) {
        if (!stat.isFile() || stat.nlink !== 1n) throw new Error('unsupported target');
        const identity = `${stat.dev}:${stat.ino}`;
        if (identities.has(identity)) throw new Error('shared identity');
        identities.add(identity);
      }
    }
  } catch {
    throw new Error('Configuration target preflight failed. Use distinct regular files with existing accessible parent directories; symlink and hardlink targets are unsupported. No configuration files were written.');
  }
  // Staged replacement is experimental: copying mode bits loses extended ACLs.
  // Keep the existing inode on ordinary writes. This is NOT atomic publication.
  let written = 0;
  try {
    for (const output of outputs) {
      io.writeFileSync(output.file, output.content, output.mode ? { mode: output.mode } : undefined);
      written++;
      if (output.mode) io.chmodSync(output.file, output.mode);
      if (output.verify) output.verify(output.file);
    }
  } catch {
    throw new Error(`Configuration write failed after ${written} completed write(s). Installation incomplete; the failing file may also be partial. Do not start services; review files before retrying.`);
  }
}
