//! Generates a JSON fixture file of (ActionData, expected_struct_hash,
//! expected_eip712_digest) tuples computed by `sig-recovery-lib`. The
//! Hardhat test `solidity/test/zk-digest-equivalence-test.js` reads this
//! file, calls `CawActionsDigestExposer.exposeComputeStructHash` /
//! `exposeEip712Digest` for each entry, and asserts byte-for-byte equality.
//!
//! Why a fixture file instead of a live shared call?
//!   - Rust + Solidity don't share an in-process FFI; we'd need a custom
//!     bridge. JSON over disk is dead simple, deterministic, replayable,
//!     and committed to the repo so CI can regenerate + diff.
//!   - The same fixture serves as a regression artifact: if anyone tweaks
//!     the digest math on either side, the test fails on existing fixtures
//!     before any random new ones get generated.
//!
//! Usage:
//!   cargo run --release --bin digest-fixtures -- \
//!     --count 200 \
//!     --domain 0xab...32-byte-hex \
//!     --out ../../test/zk-digest-fixtures.json

use clap::Parser;
use serde::{Deserialize, Serialize};
use sig_recovery_lib::{
    action_data_struct_hash, eip712_digest, TinyKeccak, UnpackedAction,
};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Number of random ActionData fixtures to generate. Default 200 — enough
    /// to cover all the edge-case shapes (zero-length recipients, max-length
    /// text, varied amounts, etc.) without blowing up the on-chain test time.
    #[arg(long, default_value = "200")]
    count: usize,

    /// 32-byte hex domain separator. Tests pass this through as the EIP-712
    /// domain so the digest depends on it. Must match the on-chain
    /// `eip712DomainHash` in the helper contract the test deploys.
    #[arg(long)]
    domain: String,

    /// Output path. Truffle/Hardhat tests load it relative to project root.
    #[arg(long)]
    out: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActionFixture {
    /// All numeric fields kept as strings so JSON readers don't lose precision
    /// on uint64 amounts (JS `Number` only has 53 bits).
    action_type: u8,
    sender_id: u32,
    receiver_id: u32,
    receiver_cawonce: u32,
    network_id: u32,
    cawonce: u32,
    recipients: Vec<u32>,
    amounts: Vec<String>,    // uint64 as decimal string
    text_hex: String,        // 0x-prefixed
    expected_struct_hash: String,   // 0x-prefixed
    expected_eip712_digest: String, // 0x-prefixed
}

#[derive(Debug, Serialize, Deserialize)]
struct FixtureFile {
    domain: String,                // echoed back so the test verifies it matched
    generator: String,
    fixtures: Vec<ActionFixture>,
}

/// xorshift32 — small, deterministic, no external rand crate needed.
struct Rng(u32);
impl Rng {
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn next_in(&mut self, n: u32) -> u32 {
        self.next_u32() % n
    }
    fn next_u8(&mut self) -> u8 {
        (self.next_u32() & 0xFF) as u8
    }
}

fn parse_hex32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).expect("invalid hex");
    assert_eq!(bytes.len(), 32, "domain must be 32 bytes");
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out
}

fn main() {
    let args = Args::parse();
    let domain = parse_hex32(&args.domain);

    // Seed deterministically from the domain — same domain → same fixtures,
    // so re-running CI on the same domain gives byte-identical output.
    let seed = u32::from_be_bytes([domain[0], domain[1], domain[2], domain[3]]).max(1);
    let mut rng = Rng(seed);

    let mut fixtures = Vec::with_capacity(args.count);
    for i in 0..args.count {
        // Cover the edge cases:
        //   i=0  → no recipients, no amounts, no text   (empty everywhere)
        //   i=1  → no recipients, 1 amount (just tip)   (the sig-path default)
        //   i=2  → 1 recipient, 1 amount                (tip-other-user shape)
        //   i=3  → 1 recipient, 2 amounts               (recipient + tip)
        //   i=4  → max recipients (10), max+1 amounts   (largest legal shape)
        //   i=5  → empty arrays + 420-byte text         (text edge)
        //   i=6+ → randomized
        let (rc, ac, text_len): (usize, usize, usize) = match i {
            0 => (0, 0, 0),
            1 => (0, 1, 0),
            2 => (1, 1, 0),
            3 => (1, 2, 0),
            4 => (10, 11, 0),
            5 => (0, 0, 420),
            _ => {
                let rc = (rng.next_in(11)) as usize;
                let ac_choice = rng.next_in(3);
                let ac = match ac_choice {
                    0 => rc,            // recipients-only
                    1 => rc + 1,         // recipients + tip
                    _ => 0,              // empty (session-key default)
                };
                let text_len = (rng.next_in(421)) as usize;
                (rc, ac, text_len)
            }
        };

        let action_type = (rng.next_in(8)) as u8;
        let sender_id = rng.next_u32();
        let receiver_id = rng.next_u32();
        let receiver_cawonce = rng.next_u32();
        let network_id = rng.next_u32();
        let cawonce = rng.next_u32();
        let recipients: Vec<u32> = (0..rc).map(|_| rng.next_u32()).collect();
        let amounts_u64: Vec<u64> = (0..ac).map(|_| {
            let hi = rng.next_u32() as u64;
            let lo = rng.next_u32() as u64;
            (hi << 32) | lo
        }).collect();
        let amounts: Vec<String> = amounts_u64.iter().map(|x| x.to_string()).collect();
        let text: Vec<u8> = (0..text_len).map(|_| rng.next_u8()).collect();

        let action = UnpackedAction {
            action_type,
            sender_id,
            receiver_id,
            receiver_cawonce,
            network_id,
            cawonce,
            recipients: recipients.clone(),
            amounts: amounts_u64.clone(),
            text: &text,
            slice_start: 0, // unused for digest math
            slice_end: 0,
        };

        let struct_hash = action_data_struct_hash(&TinyKeccak, &action);
        let digest = eip712_digest(&TinyKeccak, &domain, &struct_hash);

        fixtures.push(ActionFixture {
            action_type,
            sender_id,
            receiver_id,
            receiver_cawonce,
            network_id,
            cawonce,
            recipients,
            amounts,
            text_hex: format!("0x{}", hex::encode(&text)),
            expected_struct_hash: format!("0x{}", hex::encode(struct_hash)),
            expected_eip712_digest: format!("0x{}", hex::encode(digest)),
        });
    }

    let file = FixtureFile {
        domain: format!("0x{}", hex::encode(domain)),
        generator: "solidity/zk/sig-recovery/script/src/bin/digest-fixtures.rs".into(),
        fixtures,
    };
    let json = serde_json::to_string_pretty(&file).expect("json");
    std::fs::write(&args.out, json).expect("write");
    println!("wrote {} fixtures → {}", args.count, args.out.display());
}
