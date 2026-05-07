//! Shared types + EIP-712 digest computation for the sig-recovery circuit.
//!
//! Used by:
//!   - `program/` (the circuit) — runs inside the zkVM
//!   - `script/`  (host)        — drives proving + the equivalence fuzz test
//!
//! All hashing in this crate goes through `tiny_keccak` (or SP1's keccak
//! precompile inside the zkVM — same byte-for-byte output, just faster
//! when running inside SP1). The keccak precompile is wired in `program/`,
//! not here, so this crate stays portable.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use alloy_sol_types::sol;
use serde::{Deserialize, Serialize};

sol! {
    /// Public values committed by the proof. Layout matches what the on-chain
    /// verifier reads after `verifyProof` succeeds. The Solidity verifier
    /// recomputes the leading three hashes from calldata and asserts equality
    /// with these committed values.
    struct PublicValuesStruct {
        bytes32 packedActionsHash;
        bytes32 packedSigsHash;
        bytes32 signersHash;
        bytes32 domainSeparator;
    }
}

// ============================================================================
// EIP-712 type strings — must stay byte-identical to CawActions.sol.
// We don't precompute the typehash as a constant: the typehash is just
// keccak256 of the type string, computed inside the digest builder. That
// lets the equivalence fuzz test catch any silent string drift between
// this crate and CawActions.sol.
// ============================================================================

pub const ACTIONDATA_TYPESTR: &[u8] =
    b"ActionData(uint8 actionType,uint32 senderId,uint32 receiverId,uint32 receiverCawonce,uint32 clientId,uint32 cawonce,uint32[] recipients,uint64[] amounts,bytes text)";

pub const ACTIONBATCH_TYPESTR: &[u8] =
    b"ActionBatch(uint32 senderId,uint32 firstCawonce,uint32 actionCount,bytes32 actionsHash)";

// ============================================================================
// Inputs the prover writes via SP1Stdin
// ============================================================================

/// Witness fed to the circuit. Everything except `domain_separator` is
/// already a public input via its keccak hash; the circuit recomputes
/// the hashes from these bytes and commits them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitInputs {
    pub packed_actions: Vec<u8>,
    pub packed_sigs: Vec<u8>,
    pub domain_separator: [u8; 32],
}

// ============================================================================
// Keccak abstraction — swappable so program/ uses SP1's precompile and
// script/ uses tiny_keccak. Same byte-for-byte output.
// ============================================================================

pub trait Keccak {
    fn keccak256(&self, data: &[u8]) -> [u8; 32];
}

#[cfg(feature = "std")]
pub struct TinyKeccak;

#[cfg(feature = "std")]
impl Keccak for TinyKeccak {
    fn keccak256(&self, data: &[u8]) -> [u8; 32] {
        use tiny_keccak::{Hasher, Keccak as Inner};
        let mut hasher = Inner::v256();
        hasher.update(data);
        let mut out = [0u8; 32];
        hasher.finalize(&mut out);
        out
    }
}

// ============================================================================
// Packed-actions reader. Mirrors packActions.ts on the FE and the unpack
// routine in CawActions.sol — see the layout comment in CawActions.sol
// at the top of "PACKED FORMAT ENTRY POINTS".
// ============================================================================

#[derive(Debug, Clone)]
pub struct UnpackedAction<'a> {
    pub action_type: u8,
    pub sender_id: u32,
    pub receiver_id: u32,
    pub receiver_cawonce: u32,
    pub client_id: u32,
    pub cawonce: u32,
    pub recipients: Vec<u32>,
    pub amounts: Vec<u64>,
    pub text: &'a [u8],
    /// The byte slice of `packed[slice_start..slice_end]` — used for
    /// `keccak256(slice)` which is the per-action hash leaf in the
    /// batch-sig path.
    pub slice_start: usize,
    pub slice_end: usize,
}

pub fn parse_action_count(packed: &[u8]) -> u16 {
    debug_assert!(packed.len() >= 2);
    u16::from_be_bytes([packed[0], packed[1]])
}

pub fn unpack_action(packed: &[u8], pos: usize) -> (UnpackedAction<'_>, usize) {
    let slice_start = pos;
    let action_type = packed[pos];
    let sender_id = u32::from_be_bytes(packed[pos + 1..pos + 5].try_into().unwrap());
    let receiver_id = u32::from_be_bytes(packed[pos + 5..pos + 9].try_into().unwrap());
    let receiver_cawonce = u32::from_be_bytes(packed[pos + 9..pos + 13].try_into().unwrap());
    let client_id = u32::from_be_bytes(packed[pos + 13..pos + 17].try_into().unwrap());
    let cawonce = u32::from_be_bytes(packed[pos + 17..pos + 21].try_into().unwrap());
    let rc = packed[pos + 21] as usize;
    let ac = packed[pos + 22] as usize;
    let mut p = pos + 23;
    let mut recipients = Vec::with_capacity(rc);
    for _ in 0..rc {
        recipients.push(u32::from_be_bytes(packed[p..p + 4].try_into().unwrap()));
        p += 4;
    }
    let mut amounts = Vec::with_capacity(ac);
    for _ in 0..ac {
        amounts.push(u64::from_be_bytes(packed[p..p + 8].try_into().unwrap()));
        p += 8;
    }
    let text_len = u16::from_be_bytes([packed[p], packed[p + 1]]) as usize;
    p += 2;
    let text = &packed[p..p + text_len];
    p += text_len;
    (
        UnpackedAction {
            action_type,
            sender_id,
            receiver_id,
            receiver_cawonce,
            client_id,
            cawonce,
            recipients,
            amounts,
            text,
            slice_start,
            slice_end: p,
        },
        p,
    )
}

// ============================================================================
// Packed-sigs reader. Layout (from CawActions.sol comment):
//   [2 bytes] uint16 numGroups
//   per group:
//     [2]  uint16 groupSize
//     [1]  uint8  v
//     [32] bytes32 r
//     [32] bytes32 s
// ============================================================================

#[derive(Debug, Clone)]
pub struct SigGroup {
    pub group_size: u16,
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

pub fn parse_num_groups(sigs: &[u8]) -> u16 {
    u16::from_be_bytes([sigs[0], sigs[1]])
}

pub fn unpack_sig_group(sigs: &[u8], pos: usize) -> (SigGroup, usize) {
    let group_size = u16::from_be_bytes([sigs[pos], sigs[pos + 1]]);
    let v = sigs[pos + 2];
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&sigs[pos + 3..pos + 35]);
    s.copy_from_slice(&sigs[pos + 35..pos + 67]);
    (SigGroup { group_size, v, r, s }, pos + 67)
}

// ============================================================================
// EIP-712 digest builders. Match `_computeStructHash` and `_verifyBatchSignature`
// in CawActions.sol exactly.
// ============================================================================

/// Solidity `abi.encodePacked(uint32[])` and `abi.encodePacked(uint64[])`
/// each pad ELEMENTS of dynamic arrays to 32 bytes (this is Solidity's
/// abi.encodePacked behavior for *dynamic* arrays: it falls back to the
/// abi-encoding rules for elements rather than the "natural width"
/// behavior used for non-array value types).
///
/// We learned this the hard way via the digest equivalence fuzz test —
/// Rust originally wrote 4-byte / 8-byte natural widths and digests
/// silently diverged from Solidity. Don't change without re-running
/// `test/zk-digest-equivalence-test.js`.
fn pack_u32_array(arr: &[u32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(arr.len() * 32);
    for &x in arr {
        let mut padded = [0u8; 32];
        padded[28..].copy_from_slice(&x.to_be_bytes());
        buf.extend_from_slice(&padded);
    }
    buf
}

fn pack_u64_array(arr: &[u64]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(arr.len() * 32);
    for &x in arr {
        let mut padded = [0u8; 32];
        padded[24..].copy_from_slice(&x.to_be_bytes());
        buf.extend_from_slice(&padded);
    }
    buf
}

/// Left-pad a value to 32 bytes (big-endian). EIP-712 abi.encode of a fixed-size
/// integer fills with leading zeros.
fn left_pad_32(bytes: &[u8]) -> [u8; 32] {
    debug_assert!(bytes.len() <= 32);
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

/// Compute the ActionData EIP-712 struct hash. Matches `_computeStructHash`
/// in CawActions.sol exactly — same field order, same packing, same
/// recip/amounts/text hashing.
pub fn action_data_struct_hash<K: Keccak>(k: &K, action: &UnpackedAction<'_>) -> [u8; 32] {
    let recip_hash = k.keccak256(&pack_u32_array(&action.recipients));
    let amt_hash = k.keccak256(&pack_u64_array(&action.amounts));
    let text_hash = k.keccak256(action.text);
    let typehash = k.keccak256(ACTIONDATA_TYPESTR);

    let mut buf = Vec::with_capacity(32 * 10);
    buf.extend_from_slice(&typehash);
    buf.extend_from_slice(&left_pad_32(&[action.action_type]));
    buf.extend_from_slice(&left_pad_32(&action.sender_id.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&action.receiver_id.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&action.receiver_cawonce.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&action.client_id.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&action.cawonce.to_be_bytes()));
    buf.extend_from_slice(&recip_hash);
    buf.extend_from_slice(&amt_hash);
    buf.extend_from_slice(&text_hash);
    k.keccak256(&buf)
}

/// EIP-712 digest = keccak256("\x19\x01" || domainSeparator || structHash)
pub fn eip712_digest<K: Keccak>(
    k: &K,
    domain_separator: &[u8; 32],
    struct_hash: &[u8; 32],
) -> [u8; 32] {
    let mut buf = Vec::with_capacity(2 + 32 + 32);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(domain_separator);
    buf.extend_from_slice(struct_hash);
    k.keccak256(&buf)
}

/// ActionBatch struct hash. `actions_hash` is keccak256(abi.encodePacked(perActionHashes))
/// where each perActionHash is keccak256(packed_action_slice).
pub fn action_batch_struct_hash<K: Keccak>(
    k: &K,
    sender_id: u32,
    first_cawonce: u32,
    action_count: u32,
    actions_hash: &[u8; 32],
) -> [u8; 32] {
    let typehash = k.keccak256(ACTIONBATCH_TYPESTR);
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&typehash);
    buf.extend_from_slice(&left_pad_32(&sender_id.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&first_cawonce.to_be_bytes()));
    buf.extend_from_slice(&left_pad_32(&action_count.to_be_bytes()));
    buf.extend_from_slice(actions_hash);
    k.keccak256(&buf)
}
