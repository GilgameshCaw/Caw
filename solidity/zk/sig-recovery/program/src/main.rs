//! Sig-recovery circuit for CAW.
//!
//! Reads a (packedActions, packedSigs, domainSeparator) witness from
//! SP1Stdin, walks every signature group, recovers the signer of each
//! group's EIP-712 message, builds a flat `signers[i]` array indexed by
//! action position (with intra-group entries all set to the group's
//! recovered signer), and commits four public values:
//!
//!   keccak256(packedActions)
//!   keccak256(packedSigs)
//!   keccak256(abi.encodePacked(signers))
//!   domainSeparator (unmodified, just re-published as a public input)
//!
//! The on-chain `processActionsWithZkSigs` recomputes the first three
//! hashes from calldata, asserts equality with the public-input commitments,
//! then trusts the supplied `signers[]` array (no per-action ecrecover).

#![no_main]
sp1_zkvm::entrypoint!(main);

extern crate alloc;

use alloc::vec::Vec;
use alloy_sol_types::SolType;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sig_recovery_lib::{
    action_batch_struct_hash, action_data_struct_hash, eip712_digest, parse_action_count,
    parse_num_groups, unpack_action, unpack_sig_group, CircuitInputs, Keccak,
    PublicValuesStruct,
};
use tiny_keccak::{Hasher, Keccak as TinyKeccak};

/// Inside the zkVM, tiny_keccak's `Keccak::v256` is patched to call SP1's
/// keccak_permute precompile. The interface stays identical; the heavy lifting
/// is just much cheaper inside the proof.
struct ZkKeccak;

impl Keccak for ZkKeccak {
    fn keccak256(&self, data: &[u8]) -> [u8; 32] {
        let mut hasher = TinyKeccak::v256();
        hasher.update(data);
        let mut out = [0u8; 32];
        hasher.finalize(&mut out);
        out
    }
}

/// Recover the 20-byte Ethereum address that produced (v, r, s) over `digest`.
/// `v` is the EIP-155-naïve form (27 or 28); k256 wants a 0/1 RecoveryId.
fn ecdsa_recover(digest: &[u8; 32], v: u8, r: &[u8; 32], s: &[u8; 32]) -> [u8; 20] {
    let mut sig_bytes = [0u8; 64];
    sig_bytes[..32].copy_from_slice(r);
    sig_bytes[32..].copy_from_slice(s);
    let signature = Signature::from_slice(&sig_bytes).expect("invalid (r,s)");
    let recovery_id = RecoveryId::try_from(v.wrapping_sub(27)).expect("v must be 27 or 28");

    let verifying_key = VerifyingKey::recover_from_prehash(digest, &signature, recovery_id)
        .expect("ecdsa_recover failed");

    // Address = last 20 bytes of keccak256(uncompressed_pubkey[1..])
    // (Drop the 0x04 prefix from SEC1 uncompressed encoding.)
    let encoded = verifying_key.to_encoded_point(false);
    let pubkey_bytes = encoded.as_bytes();
    debug_assert_eq!(pubkey_bytes.len(), 65);
    debug_assert_eq!(pubkey_bytes[0], 0x04);

    let mut hasher = TinyKeccak::v256();
    hasher.update(&pubkey_bytes[1..]);
    let mut hash = [0u8; 32];
    hasher.finalize(&mut hash);

    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    addr
}

pub fn main() {
    // SP1 reads the entire CircuitInputs blob in one go (bincode-serialized
    // by the host). One read keeps the syscall count low.
    let inputs: CircuitInputs = sp1_zkvm::io::read::<CircuitInputs>();
    let CircuitInputs { packed_actions, packed_sigs, domain_separator } = inputs;

    let k = ZkKeccak;
    let action_count = parse_action_count(&packed_actions) as usize;
    let num_groups = parse_num_groups(&packed_sigs) as usize;
    assert!(num_groups > 0 && num_groups <= action_count, "Bad sig group count");

    // Walk groups. For each group: figure out which action range it covers,
    // compute the group's digest (single-action vs ActionBatch), recover the
    // signer, fill signers[range] with that single address.
    let mut signers: Vec<[u8; 20]> = Vec::with_capacity(action_count);

    let mut action_pos: usize = 2; // skip 2-byte actionCount header
    let mut sig_pos: usize = 2;    // skip 2-byte numGroups header
    let mut actions_seen: usize = 0;

    for _g in 0..num_groups {
        let (group, next_sig_pos) = unpack_sig_group(&packed_sigs, sig_pos);
        sig_pos = next_sig_pos;
        let group_size = group.group_size as usize;
        assert!(group_size > 0, "Empty group");
        assert!(actions_seen + group_size <= action_count, "Group overflows actions");

        // Unpack every action in the group up front. We need their parsed
        // fields (for single-sig digest) AND the raw byte slices (for
        // batch-sig per-action leaves).
        let mut group_actions = Vec::with_capacity(group_size);
        for _ in 0..group_size {
            let (a, next) = unpack_action(&packed_actions, action_pos);
            action_pos = next;
            group_actions.push(a);
        }

        let struct_hash = if group_size == 1 {
            // Single-action sig — digest over ActionData typehash.
            action_data_struct_hash(&k, &group_actions[0])
        } else {
            // Batch sig — digest over ActionBatch(senderId, firstCawonce,
            // actionCount, actionsHash). actionsHash =
            // keccak256(abi.encodePacked(perActionHashes)) where each
            // perActionHash = keccak256(packed_action_slice).
            //
            // We also enforce the same intra-batch invariants the contract
            // does so an invalid batch can't slip through here as a valid
            // proof and then revert on-chain (wasted prove time).
            let first = &group_actions[0];
            let mut per_action_hashes = Vec::with_capacity(group_size * 32);
            for (i, a) in group_actions.iter().enumerate() {
                if i > 0 {
                    assert_eq!(a.sender_id, first.sender_id, "Mixed senders in batch");
                    assert_eq!(
                        a.cawonce,
                        first.cawonce + i as u32,
                        "Non-contiguous cawonces in batch"
                    );
                }
                let leaf = k.keccak256(&packed_actions[a.slice_start..a.slice_end]);
                per_action_hashes.extend_from_slice(&leaf);
            }
            let actions_hash_arr = k.keccak256(&per_action_hashes);
            action_batch_struct_hash(
                &k,
                first.sender_id,
                first.cawonce,
                group_size as u32,
                &actions_hash_arr,
            )
        };

        let digest = eip712_digest(&k, &domain_separator, &struct_hash);
        let signer = ecdsa_recover(&digest, group.v, &group.r, &group.s);

        // Same recovered signer applies to every action in this group.
        for _ in 0..group_size {
            signers.push(signer);
        }

        actions_seen += group_size;
    }

    assert_eq!(actions_seen, action_count, "Sigs don't cover all actions");

    // Compute the four public-input hashes.
    let packed_actions_hash = k.keccak256(&packed_actions);
    let packed_sigs_hash = k.keccak256(&packed_sigs);

    // signers_hash = keccak256(abi.encodePacked(addr1, addr2, ...)) — packs
    // each 20-byte address contiguously, no padding. Matches the on-chain
    // `keccak256(abi.encodePacked(signers))` over an `address[]`.
    let mut signers_concat = Vec::with_capacity(signers.len() * 20);
    for s in &signers {
        signers_concat.extend_from_slice(s);
    }
    let signers_hash = k.keccak256(&signers_concat);

    // Commit. The on-chain verifier reads these in order.
    let pv = PublicValuesStruct {
        packedActionsHash: packed_actions_hash.into(),
        packedSigsHash: packed_sigs_hash.into(),
        signersHash: signers_hash.into(),
        domainSeparator: domain_separator.into(),
    };
    sp1_zkvm::io::commit_slice(&PublicValuesStruct::abi_encode(&pv));
}
