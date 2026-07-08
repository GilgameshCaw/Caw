-- Add a PRF-wrapped Quick Sign session blob so the on-chain session key can ROAM
-- to a new device via the passkey (Face ID unwraps the same session key, whose
-- on-chain registration is still valid — no new registration tx). Ciphertext only;
-- the server cannot decrypt it. Nullable — populated after a session is created.
ALTER TABLE "WalletBlob" ADD COLUMN "sessionPrfBlob" TEXT;
