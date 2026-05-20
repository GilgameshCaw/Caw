#!/usr/bin/env python3
"""
gen_p256_vectors.py — Generate P-256 test vectors for SmartEOA.t.sol.

The test suite uses a mock P-256 precompile at 0x0100 that accepts any
(h, r, s, qx, qy) combination registered in P256MockRegistry. Because the
mock is hash-based, the (r, s) values in the test are arbitrary constants.

This script documents the real P-256 key derived from the test private scalar,
and generates the authentic sha256 message hash (h) for the test digest, so the
test vectors are anchored to a real cryptographic computation.

Usage:
    pip install cryptography
    python3 gen_p256_vectors.py

Output: Solidity constants for SmartEOA.t.sol.

NOTE: P-256 ECDSA signing with the `cryptography` library is randomized (uses
OS-level entropy for the nonce k, not RFC 6979 deterministic). Therefore the
(r, s) signature values differ on each run. The test harness does NOT use these
sig values — it uses arbitrary fixed constants (SIG_R_A, SIG_R_B, ...) and
registers those in the mock registry. The key coordinates (PK1_X, PK1_Y) and
the message hash (h) are what matter for correctness.
"""

import hashlib
import base64

try:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
except ImportError:
    print("ERROR: pip install cryptography")
    exit(1)

# ============================================================================
# Test private key scalar
# ============================================================================

# Private scalar for PK1 (decimal).  Generated once, hardcoded for reproducibility.
PRIV_SCALAR = 85053669634070209836134713953639729434974223139151520322346588026977323650290

priv_key = ec.derive_private_key(PRIV_SCALAR, ec.SECP256R1(), default_backend())
pub = priv_key.public_key().public_numbers()

print("=== P-256 Key Coordinates ===")
print(f"bytes32 constant PK1_X = bytes32(0x{pub.x:064x});")
print(f"bytes32 constant PK1_Y = bytes32(0x{pub.y:064x});")

# ============================================================================
# Test digest and WebAuthn message hash
# ============================================================================

TEST_DIGEST = bytes.fromhex(
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
)

AUTH_DATA = bytes(37)  # 37 zero bytes — minimal valid authenticatorData

challenge_b64 = base64.urlsafe_b64encode(TEST_DIGEST).rstrip(b'=').decode()
cdj = (
    '{"type":"webauthn.get","challenge":"' + challenge_b64 + '",'
    '"origin":"https://app.caw.social"}'
).encode()

cdj_hash = hashlib.sha256(cdj).digest()
h = hashlib.sha256(AUTH_DATA + cdj_hash).digest()

print()
print("=== WebAuthn Message Hash ===")
print(f"challenge_b64 = {challenge_b64}")
print(f"cdj = {cdj.decode()}")
print(f"cdj_hash = {cdj_hash.hex()}")
print(f"h (P-256 precompile input) = {h.hex()}")
print()
print("=== Solidity clientDataJSON Hex ===")
print(f"bytes constant CLIENT_DATA_JSON = hex\"{cdj.hex()}\";")
print()

# ============================================================================
# Notes on test vector usage
# ============================================================================

print("=== Usage Notes ===")
print()
print("The test file (SmartEOA.t.sol) uses:")
print("  PK1_X, PK1_Y — the real P-256 public key coordinates above.")
print("  SIG_R_A = 0xaaa...a  — arbitrary constant registered in P256MockRegistry.")
print("  SIG_S_A = 0xbbb...b  — arbitrary constant registered in P256MockRegistry.")
print()
print("At test runtime, the mock registry accepts keccak256(h || r || s || qx || qy)")
print("where h is computed from the test digest and CDJ above.")
print("The test registers each (digest, r, s, qx, qy) triple before calling")
print("isValidSignature — the P-256 math is exercised by the real precompile")
print("in production; the test exercises SmartEOA contract logic.")
