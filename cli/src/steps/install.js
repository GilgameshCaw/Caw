import { execSync, exec } from 'child_process'
import fs from 'fs'
import path from 'path'
import ora from 'ora'
import { section, success, warn, err, dim, brand, tipBlock } from '../utils/ui.js'

export async function runInstall(nodeType, config, installDir) {
  section('Installing Dependencies')

  const clientDir = path.join(installDir, 'client')

  // Create logs directory
  fs.mkdirSync(path.join(installDir, 'logs'), { recursive: true })

  // 1. Docker (if selected)
  if (config.useDocker === 'docker') {
    const spinner = ora('Starting Docker containers (PostgreSQL + Redis)...').start()
    try {
      execSync('docker compose up -d', { cwd: installDir, stdio: 'pipe' })
      spinner.succeed('Docker containers running')
      // Wait for PostgreSQL to be ready
      await waitForPostgres(config.dbUrl)
    } catch (e) {
      spinner.fail('Failed to start Docker containers')
      console.log(err(`  ${e.message}`))
      console.log(warn('  Make sure Docker is installed: https://docs.docker.com/get-docker/'))
      console.log(warn('  Or choose "existing instances" and configure manually.'))
      throw e
    }
  }

  // 2. Install Node.js dependencies
  const spinner2 = ora('Installing Node.js dependencies...').start()
  try {
    execSync('npm install', { cwd: clientDir, stdio: 'pipe' })
    spinner2.succeed('Node.js dependencies installed')
  } catch (e) {
    spinner2.fail('Failed to install dependencies')
    throw e
  }

  // 3. Install frontend dependencies + (production) build
  if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
    const frontendDir = path.join(clientDir, 'src/services/FrontEnd')

    const spinner3 = ora('Installing frontend dependencies...').start()
    try {
      execSync('yarn install --frozen-lockfile 2>/dev/null || yarn install', {
        cwd: frontendDir,
        stdio: 'pipe'
      })
      spinner3.succeed('Frontend dependencies installed')
    } catch (e) {
      spinner3.fail('Failed to install frontend dependencies')
      throw e
    }

    // For production deployments, build the static bundle once. Nginx serves
    // dist/ directly — no need for vite to keep running. Dev mode skips the
    // build and runs vite under pm2 like before.
    if (config.deployment === 'production') {
      const spinner3b = ora('Building frontend (production)...').start()
      try {
        execSync('yarn build', { cwd: frontendDir, stdio: 'pipe' })
        spinner3b.succeed('Frontend built — dist/ ready for nginx')
      } catch (e) {
        spinner3b.fail('Frontend build failed')
        throw e
      }
    }
  }

  // 4. Push database schema
  if (nodeType !== 'frontend-only') {
    const spinner4 = ora('Setting up database schema...').start()
    try {
      execSync('npx prisma db push --skip-generate', { cwd: clientDir, stdio: 'pipe' })
      execSync('npx prisma generate', { cwd: clientDir, stdio: 'pipe' })
      spinner4.succeed('Database schema ready')
    } catch (e) {
      spinner4.fail('Failed to set up database')
      console.log(err(`  ${e.message}`))
      console.log(warn('  Make sure PostgreSQL is running and the DATABASE_URL is correct.'))
      throw e
    }
  }

  // 5. Install pm2 globally if not present
  const spinner5 = ora('Checking pm2...').start()
  try {
    execSync('pm2 --version', { stdio: 'pipe' })
    spinner5.succeed('pm2 already installed')
  } catch {
    spinner5.text = 'Installing pm2...'
    try {
      execSync('npm install -g pm2', { stdio: 'pipe' })
      spinner5.succeed('pm2 installed')
    } catch (e) {
      spinner5.fail('Failed to install pm2')
      console.log(warn('  Try: sudo npm install -g pm2'))
      throw e
    }
  }

  console.log()
  console.log(success.bold('  All dependencies installed!'))
}

export async function startServices(nodeType, installDir) {
  section('Starting Services')

  const ecosystemPath = path.join(installDir, 'ecosystem.config.cjs')

  const spinner = ora('Starting CAW services with pm2...').start()
  try {
    execSync(`pm2 start ${ecosystemPath}`, { cwd: installDir, stdio: 'pipe' })
    spinner.succeed('Services started')
  } catch (e) {
    spinner.fail('Failed to start services')
    console.log(err(`  ${e.message}`))
    throw e
  }

  // Set up pm2 to start on boot
  console.log()
  const spinner2 = ora('Configuring auto-start on boot...').start()
  try {
    execSync('pm2 save', { stdio: 'pipe' })
    spinner2.succeed('pm2 state saved')
  } catch {
    spinner2.warn('Could not save pm2 state — run `pm2 save` manually')
  }

  console.log()
  tipBlock([
    'To auto-start on system boot, run:',
    '  pm2 startup',
    '  (follow the instructions it prints)',
    '',
    'Useful commands:',
    '  pm2 list              — show running services',
    '  pm2 logs              — tail all logs',
    '  pm2 logs caw-server   — tail server logs',
    '  pm2 restart all       — restart everything',
    '  pm2 stop all          — stop everything',
  ])
}

async function waitForPostgres(dbUrl, maxWaitMs = 30000) {
  const spinner = ora('Waiting for PostgreSQL to be ready...').start()
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    try {
      execSync(`pg_isready -h 127.0.0.1 -p 5432 -q`, { stdio: 'pipe' })
      spinner.succeed('PostgreSQL is ready')
      return
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  spinner.warn('PostgreSQL may not be ready yet — continuing anyway')
}
