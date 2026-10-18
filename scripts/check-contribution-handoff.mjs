#!/usr/bin/env node
/**
 * Optional, local continuity check for CAW contribution handoff notes.
 *
 * It validates the presence and shape of continuation information. It does
 * not run commands, fetch evidence, assign maintainers, or grant permissions.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const STATES = new Set(['in-progress', 'paused', 'complete'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Returns diagnostics; does not mutate the input or trust its references. */
export function validateContributionHandoff(document) {
  const errors = []
  const requireText = (value, path) => {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(path + ': expected non-empty text')
    }
  }
  const textList = (value, path, min = 0) => {
    if (!Array.isArray(value)) {
      errors.push(path + ': expected an array')
      return
    }
    if (value.length < min) errors.push(path + ': expected at least ' + min + ' item(s)')
    value.forEach((item, index) => requireText(item, path + '[' + index + ']'))
  }
  const recordList = (value, path, fields, min = 0) => {
    if (!Array.isArray(value)) {
      errors.push(path + ': expected an array')
      return
    }
    if (value.length < min) errors.push(path + ': expected at least ' + min + ' item(s)')
    value.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(path + '[' + index + ']: expected an object')
        return
      }
      for (const field of fields) requireText(item[field], path + '[' + index + '].' + field)
    })
  }

  if (!isRecord(document)) return ['$: expected a JSON object']
  if (document.version !== 1) errors.push('$.version: expected 1')
  requireText(document.goal, '$.goal')
  if (!STATES.has(document.status)) {
    errors.push('$.status: expected in-progress, paused, or complete')
  }
  textList(document.scope, '$.scope', 1)
  recordList(document.evidence, '$.evidence', ['ref', 'meaning'], 1)
  recordList(document.decisions, '$.decisions', ['choice', 'reason'])
  recordList(document.checks, '$.checks', ['command', 'expected'], 1)
  textList(document.unknowns, '$.unknowns')
  textList(document.nextSteps, '$.nextSteps', document.status === 'complete' ? 0 : 1)
  return errors
}

function checkFile(file) {
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return ['Cannot read or parse ' + file + ': ' + error.message]
  }
  return validateContributionHandoff(document)
}

let invokedAsScript = false
try {
  invokedAsScript = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {}

if (invokedAsScript) {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('Usage: node scripts/check-contribution-handoff.mjs <handoff.json> [...]')
    process.exitCode = 2
  } else {
    for (const file of files) {
      const errors = checkFile(file)
      if (errors.length === 0) {
        console.log('PASS ' + file + ': continuation information is structurally present')
      } else {
        console.error('FAIL ' + file)
        for (const error of errors) console.error('  - ' + error)
        process.exitCode = 1
      }
    }
  }
}
