// Service-list drift check. Compares an installed node's client/config.json
// against what buildServiceList() would generate for that node today, and
// reports services the generator now emits that the node does not run.
//
// Motivating case (2026-09): DepositWatcher and StakeLedgerReconciler were
// added to buildServiceList. Fresh installs got them; every existing node
// kept its old config.json and silently never ran either, so L1 deposits
// never reached the stake ledger and the drift compounded into a halt. The
// only fix was an operator editing config.json by hand after reading a
// commit message. This makes `caw update` say so on every run, and lets
// `caw doctor --fix` append the missing entries.
//
// Read-only unless `fix` is passed. Never removes or rewrites existing
// entries — an operator may have deliberately disabled a service.

import fs from 'fs'
import path from 'path'
import { buildServiceList } from './generate.js'
import { success, warn, dim, brand } from '../utils/ui.js'

const NODE_TYPES = ['full', 'frontend-api', 'api-only', 'validator', 'frontend-only']

function parseDotenv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[m[1]] = val
  }
  return out
}

/**
 * config.json does not record the node type, so infer it: the type whose
 * generated service set best explains the services actually present
 * (most overlap, fewest unexplained extras). Pure; unit-tested.
 */
export function inferNodeType(actualNames, genConfig) {
  const actual = new Set(actualNames)
  let best = null
  for (const type of NODE_TYPES) {
    const expected = new Set(buildServiceList(type, genConfig).map(s => s.service))
    let overlap = 0
    for (const n of actual) if (expected.has(n)) overlap++
    const extras = actual.size - overlap      // present but not generated for this type
    const missing = expected.size - overlap   // generated for this type but absent
    // Penalise both directions so a superset type (full) cannot win by
    // merely containing everything a smaller node runs.
    const score = overlap - extras - missing
    if (!best || score > best.score) best = { type, score }
  }
  return best ? best.type : 'full'
}

/**
 * Pure diff. `actualServices` is the parsed config.json array; `genConfig`
 * is the minimal answers object buildServiceList reads (network, networkId,
 * validatorId, ...). Returns the inferred node type plus the generator
 * entries missing from the node, ready to append verbatim.
 */
export function diffServices(actualServices, genConfig) {
  const actualNames = actualServices.map(s => s && s.service).filter(Boolean)
  const nodeType = inferNodeType(actualNames, genConfig)
  const expected = buildServiceList(nodeType, genConfig)
  const have = new Set(actualNames)
  const missing = expected.filter(e => !have.has(e.service))
  const expectedNames = new Set(expected.map(e => e.service))
  const extra = actualNames.filter(n => !expectedNames.has(n))
  return { nodeType, missing, extra }
}

/**
 * Reads the install, prints findings, optionally appends the missing
 * entries. Returns { ran, nodeType, missing, fixed }.
 */
export function reportServiceDrift(installDir, { fix = false } = {}) {
  const configPath = path.join(installDir, 'client', 'config.json')
  const envPath = path.join(installDir, 'client', '.env')
  if (!fs.existsSync(configPath)) return { ran: false, reason: 'client/config.json not found' }

  let actual
  try {
    actual = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) {
    return { ran: false, reason: `client/config.json is not valid JSON: ${e.message}` }
  }
  if (!Array.isArray(actual)) return { ran: false, reason: 'client/config.json is not a service array' }

  const env = fs.existsSync(envPath) ? parseDotenv(fs.readFileSync(envPath, 'utf8')) : {}
  const genConfig = {
    network: env.L1_CHAIN_ID === '1' ? 'mainnet' : 'testnet',
    networkId: env.NETWORK_ID ? Number(env.NETWORK_ID) : undefined,
    validatorId: env.VALIDATOR_ID ? Number(env.VALIDATOR_ID) : undefined,
  }

  const { nodeType, missing } = diffServices(actual, genConfig)
  if (missing.length === 0) {
    console.log(dim(`  Service list matches the generator for a ${nodeType} node.`))
    return { ran: true, nodeType, missing, fixed: false }
  }

  console.log(warn(`  ⚠ ${missing.length} service(s) the installer now generates for a ${nodeType} node are missing from client/config.json:`))
  for (const m of missing) console.log(warn(`      - ${m.service}`))
  if (fix) {
    const next = [...actual, ...missing]
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n')
    console.log(success(`  Appended ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} to ${dim(configPath)} — review the config values, then restart (pm2 restart).`))
    return { ran: true, nodeType, missing, fixed: true }
  }
  console.log(brand('  Action needed: run `caw doctor --fix` to append them (values below), then restart.'))
  for (const m of missing) console.log(dim('    ' + JSON.stringify(m)))
  return { ran: true, nodeType, missing, fixed: false }
}
