import { createRequestHandler } from "@react-router/node";
import * as build from "../build/server/index.js";

const handler = createRequestHandler({ build });

export default handler;

// Tell Vercel NOT to parse the body — the raw stream must reach
// authenticate.webhook() intact for HMAC verification to pass.
export const config = {
  api: {
    bodyParser: false,
  },
};
