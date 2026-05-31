import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const updated = await db.settings.updateMany({
  where: { fulfillmentWritebackEnabled: false },
  data: { fulfillmentWritebackEnabled: true },
});
console.log(`Updated ${updated.count} store(s).`);
await db.$disconnect();
