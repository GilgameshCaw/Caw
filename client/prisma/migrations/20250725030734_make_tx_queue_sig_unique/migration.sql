/*
  Warnings:

  - A unique constraint covering the columns `[signedTx]` on the table `TxQueue` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "TxQueue_signedTx_key" ON "TxQueue"("signedTx");
