import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

(async () => {
  const counts = await p.txQueue.groupBy({
    by: ["status"],
    _count: true,
    orderBy: { status: "asc" },
  });
  console.log("=== status counts ===");
  for (const c of counts) console.log(c.status, c._count);

  const max = await p.txQueue.aggregate({ _max: { id: true } });
  console.log("max id:", max._max.id);

  const targets = [11846, 11827];
  console.log("\n=== specific IDs (if present) ===");
  const found = await p.txQueue.findMany({ where: { id: { in: targets } }, orderBy: { id: "asc" } });
  console.log("found", found.length, "of", targets.length);
  for (const r of found) console.log(JSON.stringify(r, null, 2));

  console.log("\n=== rows currently 'processing' ===");
  const stuck = await p.txQueue.findMany({
    where: { status: "processing" },
    orderBy: { id: "asc" },
  });
  for (const r of stuck) {
    const d: any = (r.payload as any)?.data ?? {};
    console.log(JSON.stringify({
      id: r.id,
      senderId: r.senderId,
      cawonce: r.cawonce,
      batchId: r.batchId,
      actionType: d.actionType,
      receiverId: d.receiverId,
      receiverCawonce: d.receiverCawonce,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      reason: r.reason,
      ageMin: Math.round((Date.now() - r.updatedAt.getTime()) / 60000),
    }));
  }
  await p.$disconnect();
})();
