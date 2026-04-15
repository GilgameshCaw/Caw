// Post-build step for the ESM dist:
//   1. Mark dist-esm/ as an ES module so Node treats *.js as ESM.
//   2. Add explicit .js extensions to relative imports (Node ESM requires them,
//      but tsc emits extensionless specifiers).
const fs = require('fs');
const path = require('path');

const esmDir = path.join(__dirname, '..', 'dist-esm');
const srcDir = path.join(esmDir, 'src');

fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }));

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.js')) continue;
  const filePath = path.join(srcDir, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const patched = original.replace(
    /from '(\.\.?\/[^']+)'/g,
    (match, spec) => spec.endsWith('.js') ? match : `from '${spec}.js'`
  );
  if (patched !== original) fs.writeFileSync(filePath, patched);
}
