import db from "../db.server";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
];

export const loader = async () => {
  const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    return Response.json(
      { ok: false, environment: "error", missingEnv },
      { status: 503 },
    );
  }

  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, environment: "ok", database: "ok" });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        environment: "ok",
        database: "error",
        message: error.message,
      },
      { status: 503 },
    );
  }
};
