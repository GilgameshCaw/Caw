// Config-drift doctor check. READ-ONLY: compares address vars in an
// install's client/.env against the canonical values in
// solidity/.deploy-state.json and WARNS on mismatch. Never rewrites .env —
// the operator decides what to do; this just makes drift visible instead of
// silent.
//
// Motivating bug (reported by validator nyaromesama): SmartEOA is deployed
// by its own script (solidity/scripts/deploy-smarteoa-create2.js), separate
// from the main deploy.js. That script updates .deploy-state.json and
// client/src/abi/addresses.ts, but NOT an operator's already-generated
// client/.env — so SMART_EOA_ADDRESS can drift stale in .env while
// addresses.ts has the canonical value. The two are ABI-compatible so calls
// go through, but the 7702 delegation-designator check (useSessionKey.ts
// builds `0xef0100${SMART_EOA_ADDRESS}`) and the sponsor authority can then
// mismatch what's actually deployed. Nothing else looks broken, so it's easy
// to miss.
//
// More generally: ANY address var in client/.env that diverges from
// .deploy-state.json is the same latent footgun. This check covers every
// var the CLI itself writes into .env that has a 1:1 counterpart in
// .deploy-state.json's `addresses` map (L1-side; see the mapping below —
// mirrors the `consts` object in generate.js's writeAddressesForNetwork).

import fs from 'fs'
import path from 'path'
import { section, success, warn, dim } from '../utils/ui.js'

// .env var name -> key in .deploy-state.json's `addresses` object. Only
// L1-side singletons are covered here (the ones SponsorService and the FE
// population-routing logic read directly out of process.env / addresses.ts
// without any per-Network L2 resolution). Keep in sync with the `consts`
// map in generate.js's writeAddressesForNetwork — these are the same
// addresses, just read from two different generated artifacts (.env vs
// addresses.ts) that can fall out of sync with each other.
const ENV_TO_DEPLOY_STATE_KEY = {
  // SponsorService/index.ts (~L1192) reads these three off process.env.
  CAW_NAMES_MINTER_ADDRESS: 'CawProfileMinter',
  CAW_NAMES_ADDRESS: 'CawProfile',
  SMART_EOA_ADDRESS: 'SmartEOA',
}

/**
 * Parse a .env file into a flat { KEY: value } map. Tolerates quoted
 * values (matches the parser convention used elsewhere in the CLI).
 */
function parseDotenv(text) {
  const parsed = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    parsed[m[1]] = val
  }
  return parsed
}

/**
 * Core comparison. Pure function, no I/O side effects beyond the reads
 * passed in — easy to unit-test and safe to call from either the `update`
 * flow or a standalone command.
 *
 * @param {Record<string,string>} envVars - parsed client/.env
 * @param {Record<string,string>} deployStateAddresses - deploy-state.json's `addresses` map
 * @returns {{ ok: boolean, mismatches: Array<{envVar, deployStateKey, envValue, deployStateValue}>, skipped: Array<{envVar, reason}> }}
 */
export function diffConfigAddresses(envVars, deployStateAddresses) {
  const mismatches = []
  const skipped = []

  for (const [envVar, deployStateKey] of Object.entries(ENV_TO_DEPLOY_STATE_KEY)) {
    const envValue = envVars[envVar]
    const deployStateValue = deployStateAddresses[deployStateKey]

    if (!envValue && !deployStateValue) {
      skipped.push({ envVar, reason: 'absent on both sides' })
      continue
    }
    if (!envValue) {
      skipped.push({ envVar, reason: `not set in .env (deploy-state has ${deployStateValue})` })
      continue
    }
    if (!deployStateValue) {
      skipped.push({ envVar, reason: `no ${deployStateKey} in deploy-state.json addresses` })
      continue
    }
    if (envValue.toLowerCase() !== deployStateValue.toLowerCase()) {
      mismatches.push({ envVar, deployStateKey, envValue, deployStateValue })
    }
  }

  return { ok: mismatches.length === 0, mismatches, skipped }
}

/**
 * Read client/.env + solidity/.deploy-state.json off disk and run the
 * diff. Handles both files being missing or malformed — returns a
 * "skip everything" result rather than throwing, since this check is a
 * courtesy warning, not a gate.
 *
 * @param {string} installDir - repo/install root (parent of client/ and solidity/)
 */
export function checkConfigDrift(installDir) {
  const envPath = path.join(installDir, 'client', '.env')
  const deployStatePath = path.join(installDir, 'solidity', '.deploy-state.json')

  if (!fs.existsSync(envPath)) {
    return { ran: false, reason: `no ${envPath}` }
  }
  if (!fs.existsSync(deployStatePath)) {
    return { ran: false, reason: `no ${deployStatePath}` }
  }

  let envVars
  try {
    envVars = parseDotenv(fs.readFileSync(envPath, 'utf8'))
  } catch (e) {
    return { ran: false, reason: `could not read ${envPath}: ${e.message}` }
  }

  let deployState
  try {
    deployState = JSON.parse(fs.readFileSync(deployStatePath, 'utf8'))
  } catch (e) {
    return { ran: false, reason: `could not parse ${deployStatePath}: ${e.message}` }
  }
  const deployStateAddresses = deployState?.addresses || {}

  const diff = diffConfigAddresses(envVars, deployStateAddresses)
  return { ran: true, envPath, deployStatePath, ...diff }
}

/**
 * Print the result of checkConfigDrift() in the CLI's usual style.
 * Read-only, warn-only — never throws, never writes .env.
 */
export function reportConfigDrift(installDir) {
  section('Checking for config drift (client/.env vs solidity/.deploy-state.json)')

  const result = checkConfigDrift(installDir)
  if (!result.ran) {
    console.log(dim(`  Skipping — ${result.reason}`))
    return result
  }

  if (result.mismatches.length === 0) {
    console.log(success(`  OK — ${Object.keys(ENV_TO_DEPLOY_STATE_KEY).length - result.skipped.length} address var(s) match deploy-state.json`))
  } else {
    console.log(warn(`  ⚠ ${result.mismatches.length} address var(s) drifted from deploy-state.json:`))
    for (const { envVar, deployStateKey, envValue, deployStateValue } of result.mismatches) {
      console.log(warn(`    ${envVar} mismatch:`))
      console.log(warn(`      client/.env:              ${envValue}`))
      console.log(warn(`      deploy-state.json.${deployStateKey}: ${deployStateValue}`))
    }
    console.log()
    console.log(dim('  This is a WARNING only — nothing was changed. If deploy-state.json is'))
    console.log(dim('  the current canonical deploy, update the .env value(s) above by hand and'))
    console.log(dim('  restart (e.g. `pm2 startOrReload ecosystem.config.cjs`).'))
  }

  if (result.skipped.length > 0) {
    console.log(dim(`  Skipped ${result.skipped.length} var(s): ${result.skipped.map(s => s.envVar).join(', ')}`))
  }

  return result
}
