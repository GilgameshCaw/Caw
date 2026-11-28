const { readFileSync } = require('node:fs')
const { compileFunction } = require('node:vm')
const ts = require('typescript')

// Execute the service module with explicit substitutes at its import boundary.
// Reject an unexpected import so offline tests cannot open live connections.
function loadSource(filename, mocks) {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  const offlineRequire = name => {
    if (!Object.hasOwn(mocks, name)) throw new Error('Unexpected offline import: ' + name)
    return mocks[name]
  }
  const mod = { exports: {} }
  compileFunction(outputText, ['require', 'exports', 'module'], { filename })(offlineRequire, mod.exports, mod)
  return mod.exports
}

module.exports = { loadSource }
