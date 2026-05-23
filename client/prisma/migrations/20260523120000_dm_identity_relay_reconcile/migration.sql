-- Migration: dm_identity_relay_reconcile
-- Adds two columns to DmIdentity for the identity-relay reconciliation pass
-- (audit 2026-05-22 DM-2).
--
-- relayedWalletAddress: wallet address submitted by the source instance at
--   tentative-accept time (when local User.address was null). Null for rows
--   registered via the canonical local path.
--
-- revoked: tombstone flag set by the reconciliation pass when
--   relayedWalletAddress does not match User.address after the NftTransferWatcher
--   has indexed the token owner. Revoked rows must be ignored by identity
--   lookups and must not be used to encrypt new messages.
--
-- Apply via: prisma db execute --file=migration.sql --schema=client/prisma/schema.prisma

ALTER TABLE "DmIdentity"
  ADD COLUMN IF NOT EXISTS "relayedWalletAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "revoked" BOOLEAN NOT NULL DEFAULT FALSE;
