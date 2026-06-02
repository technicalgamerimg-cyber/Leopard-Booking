import { createRequestListener } from "@react-router/node";
import * as build from "../build/server/index.js";

const requestListener = createRequestListener({
  build,
  mode: process.env.NODE_ENV,
});

export default async function handler(request, response) {
  try {
    await requestListener(request, response);
  } catch (error) {
    console.error("[server] unhandled request error", error);

    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: false,
          error: "Internal Server Error",
          message:
            process.env.NODE_ENV === "production"
              ? "Check Vercel function logs for details."
              : error.message,
        }),
      );
    } else {
      response.end();
    }
  }
}
