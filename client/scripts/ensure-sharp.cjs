#!/usr/bin/env node
// ensure-sharp.cjs — make image uploads work on hosts whose vCPU predates
// x86-64-v2 (e.g. the "QEMU Virtual CPU version 2.5+" model some VPS
// providers expose, which lacks SSE4.2/POPCNT).
//
// Why this exists (diagnosed 2026-07-24 on test2.caw.social):
//   - sharp >= 0.33 ships prebuilt linux-x64 binaries that REQUIRE the
//     x86-64-v2 microarchitecture; on older vCPUs require('sharp') throws
//     "Unsupported CPU" and upload.ts (correctly) fail-closes every image
//     upload with "Image processing is unavailable on this server".
//   - The wasm32 fallback does NOT help on such hosts: V8 needs SSE4.1 for
//     Wasm SIMD, so @img/sharp-wasm32 dies with "Wasm SIMD unsupported".
//   - The only working path is compiling sharp's binding from source against
//     the DISTRO's libvips, which is built for baseline x86-64. Ubuntu 24.04
//     ships libvips 8.15.1, and sharp 0.33.1 is the newest sharp whose
//     global-libvips floor (8.15.1) accepts it — newer sharps demand a newer
//     libvips and silently fall back to the vendored v2 binaries, recreating
//     the crash. Hence the hard pin below.
//
// Behavior: no-op (fast) when sharp already loads — normal hosts never take
// the fallback. Never fails the install: without sharp the API still runs,
// uploads just stay fail-closed (upload.ts logs the cause).
//
// Invoked from cli/src/steps/install.js (first install) and
// cli/src/steps/update.js (dependency reinstalls). Safe to run manually:
//   cd client && node scripts/ensure-sharp.cjs

const { execSync } = require('child_process')

const FALLBACK_SHARP = 'sharp@0.33.1' // see header — max version for system libvips 8.15.x
const clientDir = require('path').resolve(__dirname, '..')

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: clientDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function sharpLoadError() {
  try {
    sh(`node -e "require('sharp')"`)
    return null
  } catch (e) {
    return `${e.stderr || ''}${e.stdout || ''}` || e.message
  }
}

function sharpReallyWorks() {
  // require() succeeding is NOT enough: a mis-linked build can load and then
  // SIGILL on the first real operation. Exercise the same ops upload.ts uses.
  try {
    sh(`node -e "
      const sharp = require('sharp');
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg().toBuffer()
        .then(b => sharp(b).rotate().resize(4, 4).png().toBuffer())
        .then(() => process.exit(0), () => process.exit(1));
    "`)
    return true
  } catch {
    return false
  }
}

const err = sharpLoadError()
if (!err) {
  if (sharpReallyWorks()) process.exit(0)
  console.log('[ensure-sharp] sharp loads but fails to process images — attempting source-build fallback')
} else if (/Unsupported CPU|microarchitecture|Wasm SIMD unsupported/i.test(err)) {
  console.log('[ensure-sharp] sharp prebuilt binaries unsupported on this CPU — building from source against system libvips')
} else {
  // Some other load failure (missing install, exotic platform) — not ours to
  // guess at. Leave the fail-closed upload behavior + its log line in place.
  console.log('[ensure-sharp] sharp failed to load for a non-CPU reason — skipping fallback. Cause:')
  console.log(err.split('\n').slice(0, 4).map(l => '  ' + l).join('\n'))
  process.exit(0)
}

try {
  // 1. System libvips headers (the whole point is linking the distro build).
  let hasVips = false
  try { sh('pkg-config --modversion vips-cpp'); hasVips = true } catch {}
  if (!hasVips) {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (isRoot) {
      console.log('[ensure-sharp] installing libvips-dev (apt)...')
      sh('apt-get install -y libvips-dev', { stdio: ['ignore', 'inherit', 'inherit'] })
    } else {
      console.log('[ensure-sharp] libvips-dev is missing and we are not root.')
      console.log('  Run: sudo apt-get install -y libvips-dev  — then re-run: node scripts/ensure-sharp.cjs')
      process.exit(0)
    }
  }

  // 2. Build toolchain for node-gyp (--no-save: host-specific, never in package.json).
  console.log('[ensure-sharp] installing build helpers (node-addon-api, node-gyp)...')
  sh('npm install --no-save --silent node-addon-api node-gyp')

  // 3. The pinned source build. --no-save on purpose: package.json keeps the
  //    modern sharp for normal hosts; only this host's node_modules is pinned.
  //    (A later `npm/yarn install` here reverts to the broken prebuilt — that is
  //    why install.js/update.js re-run this script after dependency installs.)
  console.log(`[ensure-sharp] building ${FALLBACK_SHARP} from source (takes a minute)...`)
  sh(`npm install --no-save --build-from-source ${FALLBACK_SHARP}`, { stdio: ['ignore', 'inherit', 'inherit'] })

  if (sharpReallyWorks()) {
    console.log('[ensure-sharp] OK — sharp now works on this host (source-built against system libvips). Image uploads enabled.')
  } else {
    console.log('[ensure-sharp] source build completed but sharp still fails — image uploads stay disabled (fail-closed). See upload.ts log line for the cause.')
  }
} catch (e) {
  console.log('[ensure-sharp] fallback build failed (non-fatal — image uploads stay disabled):')
  console.log(String(e.message || e).split('\n').slice(0, 6).map(l => '  ' + l).join('\n'))
}
process.exit(0)
