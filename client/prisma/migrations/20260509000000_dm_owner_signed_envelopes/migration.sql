-- DM owner-signed envelopes (Round 7 audit fix #1)
-- Adds:
--   * Message.senderSig — inner sender sig over the message envelope
--   * Message.verifiedSender — receiver's verdict (NULL = unknown / legacy)
--   * DmIdentity.walletProof — wallet-signed proof of the (userId,
--     publicKey, walletAddress) triple, replicated cross-instance so
--     peer mirrors verify against the wallet not the source instance.
--
-- All three are NULLable for the migration window — existing rows + DMs
-- already in flight don't need to be backfilled, the FE update lands
-- with the receiver verifier and starts populating the columns from
-- that point forward. After ~30 days, NULL verifiedSender rows can be
-- swept and reclassified.

ALTER TABLE "Message"    ADD COLUMN IF NOT EXISTS "senderSig"      TEXT;
ALTER TABLE "Message"    ADD COLUMN IF NOT EXISTS "verifiedSender" BOOLEAN;
ALTER TABLE "DmIdentity" ADD COLUMN IF NOT EXISTS "walletProof"    TEXT;
