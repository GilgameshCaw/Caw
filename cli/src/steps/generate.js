import fs from 'fs'
import path from 'path'
import { section, success, dim, brand, warn } from '../utils/ui.js'

/**
 * Generate config.json and .env from collected answers
 */
export function generateConfig(nodeType, config, installDir) {
  section('Generating Configuration')

  const clientDir = path.join(installDir, 'client')

  // Build config.json (services to run)
  const services = buildServiceList(nodeType, config)
  const configJsonPath = path.join(clientDir, 'config.json')
  fs.writeFileSync(configJsonPath, JSON.stringify(services, null, 2) + '\n')
  console.log(success(`  Created ${dim(configJsonPath)}`))

  // Build .env
  const envVars = buildEnvVars(nodeType, config)
  const envPath = path.join(clientDir, '.env')
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n'
  fs.writeFileSync(envPath, envContent)
  console.log(success(`  Created ${dim(envPath)}`))

  // Build .env for frontend (Vite)
  if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
    const frontendEnv = buildFrontendEnv(nodeType, config)
    const frontendEnvPath = path.join(clientDir, 'src/services/FrontEnd/.env')
    const frontendEnvContent = Object.entries(frontendEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
    fs.writeFileSync(frontendEnvPath, frontendEnvContent)
    console.log(success(`  Created ${dim(frontendEnvPath)}`))
  }

  // Build docker-compose.yml if needed
  if (config.useDocker === 'docker') {
    const dockerComposePath = path.join(installDir, 'docker-compose.yml')
    fs.writeFileSync(dockerComposePath, buildDockerCompose(config))
    console.log(success(`  Created ${dim(dockerComposePath)}`))
  }

  // Build pm2 ecosystem file
  const pm2Config = buildPm2Config(nodeType, config, installDir)
  const pm2Path = path.join(installDir, 'ecosystem.config.cjs')
  fs.writeFileSync(pm2Path, `module.exports = ${JSON.stringify(pm2Config, null, 2)}\n`)
  console.log(success(`  Created ${dim(pm2Path)}`))

  return { configJsonPath, envPath }
}

function buildServiceList(nodeType, config) {
  const services = []

  // FrontEnd service
  if (['full', 'frontend-api'].includes(nodeType)) {
    services.push({ service: 'FrontEnd', config: {} })
  }

  // API service
  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    const apiConfig = {
      port: config.apiPort || 4000,
      allowedOrigins: config.domain
        ? [`https://${config.domain}`, 'http://localhost:5173']
        : ['http://localhost:5173', 'http://localhost:5174']
    }
    if (config.domain) {
      apiConfig.shortUrlDomain = `https://${config.domain}`
    }
    services.push({ service: 'Api', config: apiConfig })
  }

  // ActionProcessor
  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    services.push({
      service: 'ActionProcessor',
      config: { redisUrl: config.redisUrl || 'redis://127.0.0.1:6379' }
    })
  }

  // Validator
  if (['full', 'validator'].includes(nodeType)) {
    services.push({
      service: 'Validator',
      config: {
        l2RpcUrl: '${L2_RPC_URL}',
        validatorId: config.validatorId,
        checkInterval: config.checkInterval || 3000
      }
    })
  }

  // RawEventsGatherer
  if (['full', 'frontend-api', 'api-only', 'validator'].includes(nodeType)) {
    services.push({
      service: 'RawEventsGatherer',
      config: {
        chainId: 84532, // Base Sepolia (update for mainnet)
        rpcUrl: '${L2_RPC_URL}'
      }
    })
  }

  // DataCleaner
  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    services.push({ service: 'DataCleaner', config: {} })
  }

  // ScheduledPostProcessor
  if (['full', 'frontend-api', 'api-only'].includes(nodeType)) {
    services.push({ service: 'ScheduledPostProcessor', config: {} })
  }

  return services
}

function buildEnvVars(nodeType, config) {
  const env = {}

  env.DATABASE_URL = config.dbUrl || 'postgresql://postgres:postgres@127.0.0.1:5432/caw'

  if (config.l2RpcUrl) {
    env.L2_RPC_URL = config.l2RpcUrl
  }
  if (config.l2RpcUrlHttp) {
    env.L2_RPC_URL_HTTP = config.l2RpcUrlHttp
  }
  if (config.ethMainnetRpcUrl) {
    env.ETH_MAINNET_RPC_URL = config.ethMainnetRpcUrl
  }
  if (config.validatorPrivateKey) {
    env.VALIDATOR_PRIVATE_KEY = config.validatorPrivateKey
  }
  if (config.adminPassword) {
    env.ADMIN_PASSWORD = config.adminPassword
  }

  env.L2_CHAIN_ID = '84532' // Base Sepolia

  return env
}

function buildFrontendEnv(nodeType, config) {
  const env = {}

  if (nodeType === 'frontend-only') {
    env.VITE_API_HOST = config.apiUrl
  } else {
    // Frontend talks to its own API
    env.VITE_API_HOST = ''
  }

  env.VITE_CLIENT_ID = String(config.clientId || 1)

  return env
}

function buildDockerCompose(config) {
  const dbPassword = config.dbUrl?.match(/:([^@]+)@/)?.[1] || 'postgres'

  return `version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_PASSWORD: ${dbPassword}
      POSTGRES_DB: caw
    ports:
      - "5432:5432"
    volumes:
      - caw_pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: always
    ports:
      - "6379:6379"
    volumes:
      - caw_redis:/data

volumes:
  caw_pgdata:
  caw_redis:
`
}

function buildPm2Config(nodeType, config, installDir) {
  const apps = []

  // Main CAW server (all backend services run in one process)
  if (nodeType !== 'frontend-only') {
    apps.push({
      name: 'caw-server',
      cwd: path.join(installDir, 'client'),
      script: 'node',
      args: '-r ./file-polyfill.js -r tsx/cjs programs/start.ts',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '1G',
      error_file: path.join(installDir, 'logs/caw-server-error.log'),
      out_file: path.join(installDir, 'logs/caw-server-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    })
  }

  // Frontend dev server (or build for production)
  if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
    apps.push({
      name: 'caw-frontend',
      cwd: path.join(installDir, 'client/src/services/FrontEnd'),
      script: 'npx',
      args: 'vite --host 0.0.0.0',
      env: {
        NODE_ENV: 'production'
      },
      error_file: path.join(installDir, 'logs/caw-frontend-error.log'),
      out_file: path.join(installDir, 'logs/caw-frontend-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    })
  }

  return { apps }
}
