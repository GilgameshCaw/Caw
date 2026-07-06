-- Add optional PRF-wrapped backup blob alongside the password-encrypted blob.
-- The PRF blob lets a passkey biometric (WebAuthn PRF extension) unlock DM keys
-- with no vault password on supported browsers. It holds the SAME 32-byte
-- secp256k1 recovery key, wrapped under a key derived from the passkey's PRF
-- secret. Nullable: existing rows have no PRF blob until the user enrols one
-- (opportunistically, after a successful password unlock, or at onboarding).
-- The server cannot decrypt either blob (both are ciphertext keyed by address).
ALTER TABLE "WalletBlob" ADD COLUMN "prfBlob" TEXT;
