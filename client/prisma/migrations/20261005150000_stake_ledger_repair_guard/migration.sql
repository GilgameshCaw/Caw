CREATE TABLE "StakeLedgerRepairGuard" (
    "networkId" INTEGER NOT NULL,
    "repairRequired" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StakeLedgerRepairGuard_pkey" PRIMARY KEY ("networkId")
);
