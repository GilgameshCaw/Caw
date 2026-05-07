/**
 * ZK prover shim.
 *
 * Spawns the Rust `prove-batch` binary at solidity/zk/sig-recovery/script/
 * with the validator's already-packed batch + grouped sigs, and returns the
 * Groth16 proof + the four committed public values. Intended to be called
 * by ValidatorService when ZK_PROVER_ENABLED=1.
 *
 * IMPORTANT: this is the LOCAL prover path. On this Mac it takes ~10–15
 * minutes per proof (one-shot setup work, then subsequent proofs are faster
 * once warm caches exist). For production we'll point the same Rust binary
 * at SP1's hosted prover network via `SP1_PROVER=network`, dropping latency
 * to ~5–10 seconds. The TS shim doesn't care which path the binary takes —
 * the prover client is selected by env in the Rust process.
 *
 * Failure modes that bubble up as exceptions:
 *   - Cargo workspace not built / `prove-batch` binary missing
 *   - Inputs malformed (caught Rust-side)
 *   - Proof generation OOM / panic (Mac runs out of headroom on large
 *     batches; mitigation is to drop batch size at the call site)
 *
 * Caller responsibility:
 *   - validate signers[] keccak matches the proof's signersHash before
 *     submitting on-chain (this catches accidental address-formatting bugs
 *     between Rust and TS — should never trigger in practice)
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface ProveBatchInput {
  /** wire-format packedActions bytes, as 0x-prefixed hex */
  packedActions: string
  /** wire-format grouped packedSigs bytes, as 0x-prefixed hex */
  packedSigs: string
  /** EIP-712 domain separator the validator's contract enforces, 32 bytes hex */
  domainSeparator: string
}

export interface ProveBatchOutput {
  /** SP1 verifying key (bytes32, 0x-prefixed) bound to the sig-recovery program */
  vkey: string
  /** abi-encoded PublicValuesStruct as 0x-prefixed hex */
  publicValues: string
  /** Groth16 proof bytes the on-chain verifier consumes */
  proof: string
  /** keccak256(packedActions) committed by the proof */
  packedActionsHash: string
  /** keccak256(packedSigs) committed by the proof */
  packedSigsHash: string
  /** keccak256(signers) committed by the proof — TS caller MUST recompute and compare */
  signersHash: string
  /** EIP-712 domain separator committed by the proof */
  domainSeparator: string
}

function repoRoot(): string {
  // services/ValidatorService → services → src → client
  // From client/src/services/ValidatorService back to repo root.
  return path.resolve(__dirname, '../../../../..')
}

function zkDir(): string {
  return path.resolve(repoRoot(), 'solidity/zk/sig-recovery')
}

/**
 * Run the Rust prover. Returns the parsed JSON output.
 *
 * The Rust binary writes the output to a file (so partial writes can't corrupt
 * stdout parsing) and we read it back.
 */
export async function proveBatch(input: ProveBatchInput): Promise<ProveBatchOutput> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'caw-zk-'))
  const inputPath = path.join(tmp, 'inputs.json')
  const outputPath = path.join(tmp, 'proof.json')

  await fs.promises.writeFile(inputPath, JSON.stringify(input))

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'cargo',
      ['run', '--release', '--bin', 'prove-batch', '--', '--input', inputPath, '--output', outputPath],
      {
        cwd: zkDir(),
        env: {
          ...process.env,
          // sp1 needs these on macOS arm64 — same flags as evm.rs setup.
          PATH: `${process.env.HOME}/.sp1/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
          LIBCLANG_PATH: process.env.LIBCLANG_PATH ?? '/Library/Developer/CommandLineTools/usr/lib',
          RUST_LOG: process.env.RUST_LOG ?? 'info',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`prove-batch exited with code ${code}`))
    })
  })

  const raw = await fs.promises.readFile(outputPath, 'utf8')
  const out: ProveBatchOutput = JSON.parse(raw)

  // Best-effort cleanup. Don't fail the call if rm fails.
  fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})

  return out
}

/**
 * True if the validator should prefer processActionsWithZkSigs over
 * processActions. Gated by env so the existing hot path remains the
 * default until the prover infra is dependable.
 *
 * Why a runtime flag rather than a code path swap: proof generation latency
 * is incompatible with the validator's sub-second submission cadence today.
 * We want to be able to flip ZK on for a single instance (e.g. an off-peak
 * mirror) without recompiling.
 */
export function isZkProverEnabled(): boolean {
  return process.env.ZK_PROVER_ENABLED === '1'
}
