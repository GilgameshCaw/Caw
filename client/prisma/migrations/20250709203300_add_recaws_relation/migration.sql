-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_originalCawId_fkey" FOREIGN KEY ("originalCawId") REFERENCES "Caw"("id") ON DELETE SET NULL ON UPDATE CASCADE;
