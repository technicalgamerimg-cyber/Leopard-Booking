import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { getShipmentById } from "../services/shipment.server";
import { getSettings } from "../services/settings.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

// Dedicated endpoint for shipment tracking events — loaded asynchronously by
// the detail page so the page renders instantly from DB data.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const store       = await ensureStore(session);
  const shipment    = await getShipmentById(store.id, params.id);

  if (!shipment?.cnNumber) {
    return Response.json({ events: [] });
  }

  try {
    const settings = await getSettings(store.id, { decrypt: true });
    if (!settings.leopardApiKey || !settings.leopardApiPassword) {
      return Response.json({ events: [] });
    }

    const client      = new LeopardApiClient({ storeId: store.id, settings });
    const trackResult = await client.trackBookedPacket([shipment.cnNumber]);

    if (!trackResult.ok) {
      return Response.json({ events: [], error: trackResult.message });
    }

    const packets = trackResult.data?.packet_list ?? trackResult.raw?.packet_list ?? [];
    const packet  = Array.isArray(packets)
      ? packets.find(
          (p) => String(p.track_number ?? p.cn_number ?? "") === String(shipment.cnNumber),
        )
      : null;

    const detail = packet?.["Tracking Detail"] ?? packet?.tracking_detail ?? packet?.trackingDetail ?? [];

    const events = Array.isArray(detail)
      ? detail.map((event, idx) => ({
          id:           String(idx),
          status:       event.Status ?? event.status ?? "",
          activityDate: event.Activity_datetime ?? event.activity_datetime ?? event.Activity_Date ?? event["Activity Date"] ?? "",
          reason:       event.Reason ?? event.reason ?? "",
          receiverName: event.Reciever_Name ?? event.Receiver_Name ?? event["Reciever Name"] ?? event["Receiver Name"] ?? event.receiver_name ?? "",
        }))
      : [];

    return Response.json({ events });
  } catch (err) {
    console.error("[api/tracking] fetch failed:", err);
    return Response.json({ events: [], error: err.message });
  }
};
