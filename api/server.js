import { createRequestHandler } from "@react-router/node";
import * as build from "../build/server/index.js";

const reactRouterHandler = createRequestHandler({ build });

export default async function handler(req, res) {
  // Read the raw body as a Buffer before anything else touches it.
  // This is critical — Shopify HMAC verification requires the exact raw bytes.
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  // Reconstruct a Web API Request that react-router and authenticate.webhook() expect.
  const url = `https://${req.headers.host}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const webRequest = new Request(url, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? rawBody : undefined,
  });

  const webResponse = await reactRouterHandler(webRequest);

  res.statusCode = webResponse.status;
  for (const [key, value] of webResponse.headers.entries()) {
    res.setHeader(key, value);
  }

  const responseBody = await webResponse.arrayBuffer();
  res.end(Buffer.from(responseBody));
}
