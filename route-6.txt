import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { downloadLoadsheet } from "../services/loadsheet.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url = new URL(request.url);
  const loadSheetId = url.searchParams.get("loadSheetId");

  if (!loadSheetId) {
    return new Response("Missing loadSheetId", { status: 400 });
  }

  const result = await downloadLoadsheet(store.id, loadSheetId);

  if (!result.ok) {
    return new Response(result.message ?? "Failed to download loadsheet.", {
      status: 502,
    });
  }

  return new Response(result.data, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="loadsheet-${loadSheetId}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
};
