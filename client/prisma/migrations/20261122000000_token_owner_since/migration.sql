-- TokenOwnerSince: the L2 block of the OwnerSet event that gave a token its
-- current owner. See utils/ownerSigned.ts.
CREATE TABLE IF NOT EXISTS "TokenOwnerSince" (
    "tokenId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "previousOwner" TEXT,
    "sinceBlock" BIGINT NOT NULL,
    "sinceLogIndex" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenOwnerSince_pkey" PRIMARY KEY ("tokenId")
);
