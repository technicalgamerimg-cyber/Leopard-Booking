import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import {
  cancelShipments,
  getShipmentById,
  refreshShipmentStatuses,
} from "../services/shipment.server";
import { resolveCityName } from "../services/city.server";
import { getSettings } from "../services/settings.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";

const TERMINAL_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED"];

const STATUS_STYLES = {
  PENDING:    { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00",  label: "Not booked" },
  BOOKED:     { dot: "#2c6ecb", bg: "#eaf4fb", text: "#0d3880",  label: "Booked" },
  IN_TRANSIT: { dot: "#5c6ac4", bg: "#f0f0ff", text: "#3d3d8f",  label: "In transit" },
  DELIVERED:  { dot: "#3d8b40", bg: "#e3f1df", text: "#1e542a",  label: "Delivered" },
  RETURNED:   { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00",  label: "Returned" },
  CANCELLED:  { dot: "#8c9196", bg: "#f6f6f7", text: "#444750",  label: "Cancelled" },
  EXCEPTION:  { dot: "#d72c0d", bg: "#fce8e7", text: "#7f0007",  label: "Exception" },
};

const EVENT_LABELS = {
  BOOKED:        "Booked",
  CANCELLED:     "Cancelled",
  STATUS_CHANGE: "Status updated",
  ERROR:         "Error",
};

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const shipment = await getShipmentById(store.id, params.id);

  if (!shipment) throw new Response("Shipment not found", { status: 404 });

  const [originCityName, destinationCityName] = await Promise.all([
    shipment.originCityId ? resolveCityName(store.id, shipment.originCityId) : null,
    shipment.destinationCityId ? resolveCityName(store.id, shipment.destinationCityId) : null,
  ]);

  let trackingEvents = [];
  if (shipment.cnNumber) {
    try {
      const settings = await getSettings(store.id, { decrypt: true });
      if (settings.leopardApiKey && settings.leopardApiPassword) {
        const client = new LeopardApiClient({ storeId: store.id, settings });
        const trackResult = await client.trackBookedPacket([shipment.cnNumber]);
        if (trackResult.ok) {
          const packets = trackResult.data?.packet_list ?? trackResult.raw?.packet_list ?? [];
          const packet = Array.isArray(packets)
            ? packets.find((p) => String(p.track_number ?? p.cn_number ?? "") === String(shipment.cnNumber))
            : null;
          const detail = packet?.["Tracking Detail"] ?? packet?.tracking_detail ?? packet?.trackingDetail ?? [];
          if (Array.isArray(detail)) {
            trackingEvents = detail.map((event, idx) => ({
              id: `${idx}`,
              status:       event.Status ?? event.status ?? "",
              activityDate: event.Activity_datetime ?? event.activity_datetime ?? event.Activity_Date ?? event.activity_date ?? event["Activity Date"] ?? "",
              reason:       event.Reason ?? event.reason ?? "",
              receiverName: event.Reciever_Name ?? event.Receiver_Name ?? event["Reciever Name"] ?? event["Receiver Name"] ?? event.receiver_name ?? "",
            }));
          }
        }
      }
    } catch (err) {
      console.error("[shipment detail] tracking fetch failed:", err);
    }
  }

  return {
    shipment: {
      ...shipment,
      bookedAt:    shipment.bookedAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
      cancelledAt: shipment.cancelledAt?.toISOString() ?? null,
      createdAt:   shipment.createdAt.toISOString(),
      updatedAt:   shipment.updatedAt.toISOString(),
      originCityName,
      destinationCityName,
      logs: shipment.logs.map((log) => ({ ...log, createdAt: log.createdAt.toISOString() })),
    },
    trackingEvents,
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const shipment = await getShipmentById(store.id, params.id);

  if (!shipment) return { ok: false, message: "Shipment not found." };

  const formData = await request.formData();
  const intent = formData.get("intent");
  const cn = shipment.cnNumber;

  if (!cn) return { ok: false, message: "Shipment has no CN number." };
  if (intent === "refresh") return refreshShipmentStatuses(store.id, [cn]);
  if (intent === "cancel")  return cancelShipments(store.id, [cn]);

  return { ok: false, message: "Unknown action." };
};

// ── Helper components ─────────────────────────────────────────────────────────

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: status };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 14, background: s.bg, color: s.text, fontSize: 13, fontWeight: 700 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

function DetailGrid({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px" }}>{children}</div>;
}

function DetailRow({ label, value, mono }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 11, color: "#8c9196", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 14, color: mono ? "#444750" : "#202223", fontFamily: mono ? "monospace" : undefined, fontWeight: mono ? 600 : 400 }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function EventLogBadge({ type }) {
  const styles = {
    BOOKED:        { bg: "#e3f1df", text: "#1e542a" },
    CANCELLED:     { bg: "#fce8e7", text: "#7f0007" },
    STATUS_CHANGE: { bg: "#f0f0ff", text: "#3d3d8f" },
    ERROR:         { bg: "#fce8e7", text: "#7f0007" },
  };
  const s = styles[type] || { bg: "#f6f6f7", text: "#444750" };
  return (
    <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 10, background: s.bg, color: s.text, fontWeight: 600 }}>
      {EVENT_LABELS[type] ?? type}
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ShipmentDetail() {
  const { shipment, trackingEvents } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data?.ok && fetcher.formData?.get("intent") === "cancel") {
      navigate("/app/shipments");
    }
  }, [fetcher.data, fetcher.formData, shopify, navigate]);

  const isTerminal = TERMINAL_STATUSES.includes(shipment.status);

  return (
    <s-page heading={shipment.shopifyOrderName}>

      {/* ── Action bar ── */}
      <s-section>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill status={shipment.status} />
          {shipment.leopardStatusRaw && (
            <span style={{ fontSize: 12, color: "#6d7175" }}>Leopards: {shipment.leopardStatusRaw}</span>
          )}
          <div style={{ flex: 1 }} />
          <s-button href="/app/shipments">← All shipments</s-button>
          {shipment.cnNumber && (
            <fetcher.Form method="post" style={{ display: "contents" }}>
              <input type="hidden" name="intent" value="refresh" />
              <s-button type="submit" disabled={busy} loading={busy && fetcher.formData?.get("intent") === "refresh"}>
                Refresh status
              </s-button>
            </fetcher.Form>
          )}
          {shipment.slipLink && (
            <s-button href={shipment.slipLink} target="_blank">Print slip</s-button>
          )}
          {shipment.cnNumber && !isTerminal && (
            <s-button tone="critical" disabled={busy} onClick={() => setConfirmCancel(true)}>
              Cancel shipment
            </s-button>
          )}
        </div>
      </s-section>

      {/* ── Error banner ── */}
      {shipment.lastError && (
        <s-section>
          <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#7f0007" }}>
            <strong>Last error:</strong> {shipment.lastError}
          </div>
        </s-section>
      )}

      {/* ── Cancel confirmation ── */}
      {confirmCancel && (
        <s-section>
          <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 8, padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#7f0007", marginBottom: 6 }}>
              Cancel shipment <span style={{ fontFamily: "monospace" }}>{shipment.cnNumber}</span>?
            </div>
            <div style={{ fontSize: 13, color: "#b40007", marginBottom: 12 }}>
              This will cancel it with Leopards Courier and cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <fetcher.Form method="post" style={{ display: "contents" }}>
                <input type="hidden" name="intent" value="cancel" />
                <s-button type="submit" tone="critical" disabled={busy} loading={busy && fetcher.formData?.get("intent") === "cancel"} onClick={() => setTimeout(() => setConfirmCancel(false), 0)}>
                  Yes, cancel
                </s-button>
              </fetcher.Form>
              <s-button onClick={() => setConfirmCancel(false)} disabled={busy}>Go back</s-button>
            </div>
          </div>
        </s-section>
      )}

      {/* ── Two-column layout: details + tracking ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 0 }}>

        {/* Shipment details card */}
        <s-section heading="Shipment details">
          <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, padding: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 24px" }}>
              <DetailRow label="Order" value={shipment.shopifyOrderName} />
              <DetailRow label="CN Number" value={shipment.cnNumber} mono />
              <DetailRow label="Consignee" value={shipment.consigneeName} />
              <DetailRow label="Phone" value={shipment.consigneePhone} />
              <DetailRow label="COD" value={shipment.codAmount > 0 ? `${shipment.codAmount.toLocaleString()} PKR` : "Prepaid"} />
              <DetailRow label="Weight" value={`${shipment.weightGrams} g`} />
              <DetailRow label="Pieces" value={shipment.noOfPieces} />
              <DetailRow label="Origin" value={shipment.originCityName ?? shipment.originCityId ?? "—"} />
              <DetailRow label="Destination" value={shipment.destinationCityName ?? shipment.destinationCityId ?? "—"} />
              {shipment.bookedAt && <DetailRow label="Booked" value={new Date(shipment.bookedAt).toLocaleString()} />}
              {shipment.deliveredAt && <DetailRow label="Delivered" value={new Date(shipment.deliveredAt).toLocaleString()} />}
              {shipment.cancelledAt && <DetailRow label="Cancelled" value={new Date(shipment.cancelledAt).toLocaleString()} />}
            </div>
            {shipment.consigneeAddress && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f1f2f4" }}>
                <div style={{ fontSize: 11, color: "#8c9196", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Address</div>
                <div style={{ fontSize: 14, color: "#444750" }}>{shipment.consigneeAddress}</div>
              </div>
            )}
          </div>
        </s-section>

        {/* Tracking timeline */}
        <s-section heading="Tracking timeline">
          {trackingEvents.length === 0 ? (
            <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "32px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📍</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#202223", marginBottom: 4 }}>No tracking events yet</div>
              <div style={{ fontSize: 13, color: "#6d7175" }}>
                {shipment.cnNumber ? "Tracking events will appear here once the shipment is picked up." : "This shipment has no CN number yet."}
              </div>
              {shipment.cnNumber && (
                <fetcher.Form method="post" style={{ marginTop: 12 }}>
                  <input type="hidden" name="intent" value="refresh" />
                  <s-button type="submit" disabled={busy} loading={busy}>Refresh tracking</s-button>
                </fetcher.Form>
              )}
            </div>
          ) : (
            <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, padding: "0 20px", position: "relative" }}>
              {trackingEvents.map((event, i) => {
                const isFirst = i === 0;
                const isLast  = i === trackingEvents.length - 1;
                return (
                  <div key={event.id} style={{ display: "flex", gap: 14, padding: "16px 0", borderBottom: !isLast ? "1px solid #f1f2f4" : "none", position: "relative" }}>
                    {/* Timeline dot */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, width: 16 }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
                        background: isFirst ? "#3d8b40" : "#c4cdd5",
                        border: isFirst ? "2px solid #3d8b40" : "2px solid #c4cdd5",
                        boxShadow: isFirst ? "0 0 0 3px #e3f1df" : "none",
                        marginTop: 3,
                      }} />
                    </div>
                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: isFirst ? 700 : 600, fontSize: 13, color: isFirst ? "#1e542a" : "#202223" }}>
                        {event.status}
                      </div>
                      {event.activityDate && (
                        <div style={{ fontSize: 12, color: "#8c9196", marginTop: 2 }}>{event.activityDate}</div>
                      )}
                      {event.reason && (
                        <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2 }}>{event.reason}</div>
                      )}
                      {event.receiverName && (
                        <div style={{ fontSize: 12, color: "#6d7175" }}>Receiver: {event.receiverName}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </s-section>
      </div>

      {/* ── App event log ── */}
      <s-section heading="Activity log">
        {shipment.logs.length === 0 ? (
          <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "20px", textAlign: "center", fontSize: 13, color: "#6d7175" }}>
            No events recorded.
          </div>
        ) : (
          <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
            {shipment.logs.map((log, i) => (
              <div key={log.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 16px", borderBottom: i < shipment.logs.length - 1 ? "1px solid #f1f2f4" : "none" }}>
                <EventLogBadge type={log.eventType} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {log.message && <div style={{ fontSize: 13, color: "#202223" }}>{log.message}</div>}
                  {(log.fromStatus || log.toStatus) && (
                    <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2 }}>
                      {log.fromStatus && <span>{log.fromStatus}</span>}
                      {log.fromStatus && log.toStatus && <span> → </span>}
                      {log.toStatus && <span>{log.toStatus}</span>}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#8c9196", whiteSpace: "nowrap", flexShrink: 0 }}>
                  {new Date(log.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
