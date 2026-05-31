import db from "../db.server";

export const loader = async () => {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, database: "ok" });
  } catch (error) {
    return Response.json(
      { ok: false, database: "error", message: error.message },
      { status: 503 },
    );
  }
};
