import runServices, { RunServicesConfig } from '../src/runServices'
import fs from 'fs'
import process from 'process'
import 'reflect-metadata'

if (!fs.existsSync('config.json')) {
  console.error('config.json not found; copy from template')
  process.exit(1)
}

const config = RunServicesConfig.parse(
  JSON.parse(fs.readFileSync('config.json', 'utf8'))
)

runServices(config)

