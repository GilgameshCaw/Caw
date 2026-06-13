-- Buy-a-sponsored-code feature.

-- Distinguish admin-minted vs buyer-paid codes; credit the buyer.
ALTER TABLE "SponsorCode" ADD COLUMN "purchasedByTokenId" INTEGER;

-- Buyer-facing record holding the encrypted plaintext code + funding amounts.
CREATE TABLE "PurchasedInviteCode" (
  "id"                 SERIAL PRIMARY KEY,
  "purchasedByTokenId" INTEGER NOT NULL,
  "senderId"           INTEGER NOT NULL,
  "cawonce"            INTEGER NOT NULL,
  "codeHash"           TEXT NOT NULL,
  "codeCiphertext"     TEXT NOT NULL,
  "giftCawWei"         TEXT NOT NULL,
  "paidCawWei"         TEXT NOT NULL,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Idempotency: one purchased code per (sender, cawonce) action.
CREATE UNIQUE INDEX "PurchasedInviteCode_senderId_cawonce_key"
  ON "PurchasedInviteCode" ("senderId", "cawonce");

CREATE INDEX "PurchasedInviteCode_purchasedByTokenId_idx"
  ON "PurchasedInviteCode" ("purchasedByTokenId");
