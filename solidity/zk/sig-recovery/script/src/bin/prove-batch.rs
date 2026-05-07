//! Generate a Groth16 proof for an arbitrary batch the validator built.
//!
//! Reads inputs from a JSON file (path passed via --input) and writes the
//! proof + committed public values to a JSON file (--output).
//!
//! Usage:
//!   cargo run --release --bin prove-batch -- \
//!     --input /tmp/zk-inputs.json --output /tmp/zk-proof.json
//!
//! Input file shape (camelCase):
//!   {
//!     "packedActions":    "0x...",   // wire-format bytes
//!     "packedSigs":       "0x...",   // grouped sigs
//!     "domainSeparator":  "0x..."    // 32 bytes
//!   }
//!
//! Output file shape (matches Groth16Fixture in evm.rs so the on-chain
//! test harness can consume it directly):
//!   {
//!     "vkey": "0x...",
//!     "publicValues": "0x...",
//!     "proof": "0x...",
//!     "packedActionsHash": "0x...",
//!     "packedSigsHash": "0x...",
//!     "signersHash": "0x...",
//!     "domainSeparator": "0x..."
//!   }
//!
//! Same prover client + ELF as `evm.rs` — the only difference is *where the
//! inputs come from*. Used by ValidatorService/zkProver.ts to turn a real
//! batch into a real proof without hardcoded values.

use alloy_sol_types::SolType;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sig_recovery_lib::{CircuitInputs, PublicValuesStruct};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};
use std::path::PathBuf;

const SIG_RECOVERY_ELF: Elf = include_elf!("sig-recovery-program");

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    packed_actions: String,
    packed_sigs: String,
    domain_separator: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    vkey: String,
    public_values: String,
    proof: String,
    packed_actions_hash: String,
    packed_sigs_hash: String,
    signers_hash: String,
    domain_separator: String,
}

fn parse_hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

fn parse_hex32(s: &str) -> [u8; 32] {
    let v = parse_hex(s);
    assert_eq!(v.len(), 32, "expected 32-byte hex string, got {}", v.len());
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();

    let raw = std::fs::read_to_string(&args.input).expect("read input file");
    let input: Input = serde_json::from_str(&raw).expect("parse input json");

    let inputs = CircuitInputs {
        packed_actions: parse_hex(&input.packed_actions),
        packed_sigs: parse_hex(&input.packed_sigs),
        domain_separator: parse_hex32(&input.domain_separator),
    };

    let client = ProverClient::from_env();
    let pk = client.setup(SIG_RECOVERY_ELF).expect("setup failed");
    let mut stdin = SP1Stdin::new();
    stdin.write(&inputs);

    eprintln!("prove-batch: starting Groth16 proof");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 prove failed");
    eprintln!("prove-batch: proof generated");

    let pv_bytes = proof.public_values.as_slice();
    let pv = PublicValuesStruct::abi_decode(pv_bytes).expect("decode public values");

    let out = Output {
        vkey: pk.verifying_key().bytes32().to_string(),
        public_values: format!("0x{}", hex::encode(pv_bytes)),
        proof: format!("0x{}", hex::encode(proof.bytes())),
        packed_actions_hash: format!("0x{}", hex::encode(pv.packedActionsHash.0)),
        packed_sigs_hash: format!("0x{}", hex::encode(pv.packedSigsHash.0)),
        signers_hash: format!("0x{}", hex::encode(pv.signersHash.0)),
        domain_separator: format!("0x{}", hex::encode(pv.domainSeparator.0)),
    };

    std::fs::write(&args.output, serde_json::to_string_pretty(&out).unwrap())
        .expect("write output file");
    eprintln!("prove-batch: wrote {}", args.output.display());
}
