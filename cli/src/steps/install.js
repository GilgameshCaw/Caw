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

  // 2. Install Node.js dependencies. We pass --legacy-peer-deps because
  // typeorm peer-depends on redis@^3||^4 but the project pins redis@^5; npm
  // 9+ enforces peers strictly and refuses, while older npm/yarn just
  // shrug. legacy-peer-deps gets us back to the permissive behavior that
  // matches what the dev environment uses.
  const spinner2 = ora('Installing Node.js dependencies...').start()
  try {
    execSync('npm install --legacy-peer-deps', { cwd: clientDir, stdio: 'pipe' })
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
      // --ignore-platform lets yarn skip platform-incompatible optional
      // packages (e.g. @rollup/rollup-darwin-x64 if someone pinned it).
      // Drop --frozen-lockfile because the lockfile is generated on a Mac
      // and re-resolves on Linux — strict mode rejects legitimate platform
      // differences.
      execSync('yarn install --ignore-platform', {
        cwd: frontendDir,
        stdio: 'pipe',
      })
      spinner3.succeed('Frontend dependencies installed')
    } catch (e) {
      spinner3.fail('Failed to install frontend dependencies')
      // Surface the actual yarn error rather than just the spinner state.
      console.log(err(`  ${e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || e}`))
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
    // Ensure the Postgres database exists. prisma db push only creates
    // schema, not the database. With multi-install we derive a per-domain
    // DB name (caw_test1_caw_social, etc.) — first install creates it,
    // subsequent installs find it. We connect to the default 'postgres'
    // database to issue CREATE DATABASE IF NOT EXISTS.
    const spinnerDb = ora('Ensuring database exists...').start()
    try {
      const dbName = config.dbUrl?.split('/').pop()?.split('?')[0]
      if (dbName && dbName !== 'postgres') {
        // psql -tc returns "1" if the DB exists, blank otherwise.
        const adminUrl = config.dbUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1')
        const exists = execSync(
          `psql "${adminUrl}" -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
          { stdio: 'pipe' }
        ).toString().trim()
        if (!exists) {
          execSync(`psql "${adminUrl}" -c "CREATE DATABASE \\"${dbName}\\""`, { stdio: 'pipe' })
          spinnerDb.succeed(`Created database "${dbName}"`)
        } else {
          spinnerDb.succeed(`Database "${dbName}" already exists`)
        }
      } else {
        spinnerDb.succeed('Database check skipped (default postgres DB)')
      }
    } catch (e) {
      spinnerDb.warn('Could not verify/create database — prisma push may fail')
      // Don't throw — let prisma try anyway. If the DB really doesn't exist
      // and the operator hasn't configured psql access, prisma will surface
      // a clear connection error.
    }

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
