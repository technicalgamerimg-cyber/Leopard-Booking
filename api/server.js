import { createRequestHandler } from "@react-router/node";
import * as build from "../build/server/index.js";

const requestHandler = createRequestHandler({
  build,
  mode: process.env.NODE_ENV,
});

export default async function handler(request, context) {
  try {
    return await requestHandler(request, context);
  } catch (error) {
    console.error("[server] unhandled request error", error);

    return Response.json(
      {
        ok: false,
        error: "Internal Server Error",
        message:
          process.env.NODE_ENV === "production"
            ? "Check Vercel function logs for details."
            : error.message,
      },
      { status: 500 },
    );
  }
}
