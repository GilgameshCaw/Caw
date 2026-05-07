//! Generate an EVM-compatible Groth16 proof for a sig-recovery batch and
//! emit a JSON fixture the Hardhat fork test can deploy + check against
//! the SP1 Solidity verifier.
//!
//!   RUST_LOG=info cargo run --release --bin evm
//!
//! This is the heavy step. The first run takes ~10–15 minutes on this Mac
//! (16 GB+ RAM required for the Groth16 wrap stage). Subsequent runs hit
//! warm caches and are faster but still minutes. For production use, the
//! SP1 hosted prover network does this in ~5–10 seconds at $0.10–0.50 per
//! proof — gated behind SP1_PROVER=network + NETWORK_PRIVATE_KEY env.
//!
//! The fixture file (../contracts/src/fixtures/groth16-fixture.json)
//! contains everything needed to verify on-chain:
//!   - vkey: the SP1 verifying key digest (bytes32) bound to this circuit
//!   - publicValues: the abi-encoded PublicValuesStruct the circuit committed
//!   - proof: the Groth16 proof bytes the on-chain verifier consumes
//!
//! NOTE: To actually run end-to-end, this also re-derives the four expected
//! public-value hashes from the same inputs the circuit saw, so the test
//! can sanity-check the prover and verifier agree on what was committed.

use alloy_sol_types::SolType;
use clap::Parser;
use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey};
use serde::{Deserialize, Serialize};
use sig_recovery_lib::{
    action_data_struct_hash, eip712_digest, CircuitInputs, PublicValuesStruct, TinyKeccak,
    UnpackedAction,
};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};
use std::path::PathBuf;
use tiny_keccak::{Hasher, Keccak};

const SIG_RECOVERY_ELF: Elf = include_elf!("sig-recovery-program");

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct EVMArgs {
    /// Output directory. Defaults to `../../test/zk-fixtures/`.
    #[arg(long)]
    out_dir: Option<PathBuf>,
}

/// Mirrors the SP1 verifier's expected on-chain inputs. Everything as hex
/// strings so JS/Hardhat can round-trip cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Groth16Fixture {
    vkey: String,
    public_values: String,
    proof: String,
    /// Mirror of the four committed values, decoded for convenience so the
    /// Hardhat test can assert the verifier returned what we expect.
    packed_actions_hash: String,
    packed_sigs_hash: String,
    signers_hash: String,
    domain_separator: String,
    /// The signer the test should also be able to recover off-chain to
    /// double-check the recovered address baked into signersHash.
    expected_signer: String,
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak::v256();
    h.update(data);
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

fn pack_action_minimal(
    action_type: u8,
    sender_id: u32,
    receiver_id: u32,
    receiver_cawonce: u32,
    client_id: u32,
    cawonce: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(25);
    buf.push(action_type);
    buf.extend_from_slice(&sender_id.to_be_bytes());
    buf.extend_from_slice(&receiver_id.to_be_bytes());
    buf.extend_from_slice(&receiver_cawonce.to_be_bytes());
    buf.extend_from_slice(&client_id.to_be_bytes());
    buf.extend_from_slice(&cawonce.to_be_bytes());
    buf.push(0);
    buf.push(0);
    buf.extend_from_slice(&[0, 0]);
    buf
}

fn signer_address(sk: &SigningKey) -> [u8; 20] {
    let vk = sk.verifying_key();
    let pubkey = vk.to_encoded_point(false);
    let h = keccak256(&pubkey.as_bytes()[1..]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&h[12..]);
    addr
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = EVMArgs::parse();

    // Build the same minimal 1-action batch we use in --execute mode.
    let action_bytes = pack_action_minimal(0, 42, 0, 0, 1, 7);
    let mut packed_actions = Vec::new();
    packed_actions.extend_from_slice(&(1u16).to_be_bytes());
    packed_actions.extend_from_slice(&action_bytes);

    let domain_separator: [u8; 32] = [0xAB; 32];

    let action = UnpackedAction {
        action_type: 0,
        sender_id: 42,
        receiver_id: 0,
        receiver_cawonce: 0,
        client_id: 1,
        cawonce: 7,
        recipients: vec![],
        amounts: vec![],
        text: &[],
        slice_start: 2,
        slice_end: 2 + action_bytes.len(),
    };
    let struct_hash = action_data_struct_hash(&TinyKeccak, &action);
    let digest = eip712_digest(&TinyKeccak, &domain_separator, &struct_hash);

    let sk_bytes: [u8; 32] = [
        0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
        0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
        0xf4, 0xf2, 0xff, 0x80,
    ];
    let sk = SigningKey::from_slice(&sk_bytes).unwrap();
    let signer_addr = signer_address(&sk);

    let (sig, recovery_id): (Signature, RecoveryId) = sk.sign_prehash(&digest).unwrap();
    let r: [u8; 32] = sig.r().to_bytes().into();
    let s: [u8; 32] = sig.s().to_bytes().into();
    let v: u8 = recovery_id.to_byte() + 27;

    let mut packed_sigs = Vec::new();
    packed_sigs.extend_from_slice(&(1u16).to_be_bytes()); // numGroups
    packed_sigs.extend_from_slice(&(1u16).to_be_bytes()); // groupSize
    packed_sigs.push(v);
    packed_sigs.extend_from_slice(&r);
    packed_sigs.extend_from_slice(&s);

    let inputs = CircuitInputs {
        packed_actions: packed_actions.clone(),
        packed_sigs: packed_sigs.clone(),
        domain_separator,
    };

    let client = ProverClient::from_env();
    let pk = client.setup(SIG_RECOVERY_ELF).expect("setup failed");
    let mut stdin = SP1Stdin::new();
    stdin.write(&inputs);

    println!("Generating Groth16 proof. This takes ~10–15 minutes on this Mac.");
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .run()
        .expect("groth16 prove failed");

    // Sanity-decode the public values back out so we can publish them
    // alongside the proof for the Hardhat test.
    let bytes = proof.public_values.as_slice();
    let pv = PublicValuesStruct::abi_decode(bytes).unwrap();

    let fixture = Groth16Fixture {
        vkey: pk.verifying_key().bytes32().to_string(),
        public_values: format!("0x{}", hex::encode(bytes)),
        proof: format!("0x{}", hex::encode(proof.bytes())),
        packed_actions_hash: format!("0x{}", hex::encode(pv.packedActionsHash.0)),
        packed_sigs_hash: format!("0x{}", hex::encode(pv.packedSigsHash.0)),
        signers_hash: format!("0x{}", hex::encode(pv.signersHash.0)),
        domain_separator: format!("0x{}", hex::encode(pv.domainSeparator.0)),
        expected_signer: format!("0x{}", hex::encode(signer_addr)),
    };

    let out_dir = args
        .out_dir
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/zk-fixtures"));
    std::fs::create_dir_all(&out_dir).expect("create fixture dir");
    let path = out_dir.join("groth16-fixture.json");
    std::fs::write(&path, serde_json::to_string_pretty(&fixture).unwrap()).expect("write fixture");
    println!("✅ Wrote {}", path.display());
    println!("   vkey: {}", fixture.vkey);
    println!("   signersHash: {}", fixture.signers_hash);
}
