import { useEffect, useRef, useState } from "react";
import {
  useFetcher, useLoaderData, useNavigate, useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { cancelShipments, getShipmentById, refreshShipmentStatuses } from "../services/shipment.server";
import { resolveCityName } from "../services/city.server";

const TERMINAL_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED"];

const STATUS_STYLES = {
  PENDING:    { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00",  label: "Not booked" },
  FAILED:     { dot: "#d72c0d", bg: "#fce8e7", text: "#7f0007",  label: "Booking failed" },
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

// ── Loader / Action (NO Leopards API call — page loads instantly) ─────────────

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const shipment = await getShipmentById(store.id, params.id);

  if (!shipment) throw new Response("Shipment not found", { status: 404 });

  const [originCityName, destinationCityName] = await Promise.all([
    shipment.originCityId      ? resolveCityName(store.id, shipment.originCityId)      : null,
    shipment.destinationCityId ? resolveCityName(store.id, shipment.destinationCityId) : null,
  ]);

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
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const shipment = await getShipmentById(store.id, params.id);

  if (!shipment) return { ok: false, message: "Shipment not found." };

  const formData = await request.formData();
  const intent   = formData.get("intent");
  const cn       = shipment.cnNumber;

  if (!cn) return { ok: false, message: "Shipment has no CN number." };
  if (intent === "refresh") return refreshShipmentStatuses(store.id, [cn]);
  if (intent === "cancel")  return cancelShipments(store.id, [cn], admin, { resetToPending: true });

  return { ok: false, message: "Unknown action." };
};

// ── Helper components ─────────────────────────────────────────────────────────

function CancelModal({ cnNumber, onConfirm, onClose, loading }) {
  useEffect(() => {
    const handleEsc = (e) => { if (e.key === "Escape" && !loading) onClose(); };
    document.addEventListener("keydown", handleEsc);
    document.body.classList.add("lb-modal-open");
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.classList.remove("lb-modal-open");
    };
  }, [onClose, loading]);

  return (
    <div
      className="lb-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="lb-modal">
        <div className="lb-modal-header">
          <div>
            <div className="lb-modal-title" style={{ color: "#7f0007" }}>
              ⚠️ Cancel shipment {cnNumber}?
            </div>
          </div>
          <button onClick={onClose} className="lb-modal-close" disabled={loading} aria-label="Close">×</button>
        </div>
        <div className="lb-modal-body">
          <p style={{ fontSize: 14, color: "#444750", margin: 0, lineHeight: 1.6 }}>
            This will cancel the shipment with Leopards Courier and remove the tracking info from Shopify. This action cannot be undone.
          </p>
        </div>
        <div className="lb-modal-footer">
          <s-button onClick={onClose} disabled={loading}>Go back</s-button>
          <s-button tone="critical" onClick={onConfirm} disabled={loading} loading={loading}>
            Yes, cancel
          </s-button>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] ?? { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: status };
  return (
    <span className="lb-pill" style={{ background: s.bg, color: s.text, borderColor: "transparent", fontSize: 13 }}>
      <span className="lb-pill-dot" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
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
    <span className="lb-pill" style={{ background: s.bg, color: s.text, borderColor: "transparent", flexShrink: 0 }}>
      {EVENT_LABELS[type] ?? type}
    </span>
  );
}

// Skeleton element shown while tracking loads asynchronously
function TrackingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 0" }}>
      {[1, 2, 3].map((n) => (
        <div key={n} style={{ display: "flex", gap: 14, padding: "16px 0", borderBottom: n < 3 ? "1px solid #f1f2f4" : "none" }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#e1e3e5", flexShrink: 0, marginTop: 3 }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 14, background: "#e1e3e5", borderRadius: 4, width: `${40 + n * 15}%`, marginBottom: 6 }} />
            <div style={{ height: 11, background: "#f1f2f4", borderRadius: 4, width: "30%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ShipmentDetail() {
  const { shipment } = useLoaderData();
  const fetcher      = useFetcher();
  const navigate     = useNavigate();
  const shopify      = useAppBridge();
  const prevFetcherData = useRef(null);

  const [confirmCancel, setConfirmCancel] = useState(false);

  // ── Async tracking load — page renders immediately, tracking loads in background
  const [trackingEvents,  setTrackingEvents]  = useState(null); // null = loading, [] = empty
  const [trackingError,   setTrackingError]   = useState(null);

  useEffect(() => {
    if (!shipment.cnNumber) { setTrackingEvents([]); return; }
    fetch(`/api/tracking/${shipment.id}`)
      .then((r) => r.json())
      .then((data) => {
        setTrackingEvents(data.events ?? []);
        if (data.error) setTrackingError(data.error);
      })
      .catch((err) => {
        setTrackingEvents([]);
        setTrackingError(err.message);
      });
  }, [shipment.cnNumber, shipment.id]);

  useEffect(() => {
    if (!fetcher.data || fetcher.data === prevFetcherData.current) return;
    prevFetcherData.current = fetcher.data;
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data?.ok && fetcher.formData?.get("intent") === "cancel") {
      navigate("/app/shipments");
    }
    // After a refresh, re-fetch tracking
    if (fetcher.data?.ok && fetcher.formData?.get("intent") === "refresh" && shipment.cnNumber) {
      setTrackingEvents(null);
      setTrackingError(null);
      fetch(`/api/tracking/${shipment.id}`)
        .then((r) => r.json())
        .then((data) => { setTrackingEvents(data.events ?? []); })
        .catch(() => setTrackingEvents([]));
    }
  }, [fetcher.data, fetcher.formData, shipment, shopify, navigate]);

  const busy       = fetcher.state !== "idle";
  const isTerminal = TERMINAL_STATUSES.includes(shipment.status);
  const hasFailed  = Boolean(shipment.lastError) && shipment.status === "PENDING";

  return (
    <s-page heading={shipment.shopifyOrderName}>

      {/* ── Cancel confirmation modal (centered overlay) ── */}
      {confirmCancel && (
        <CancelModal
          cnNumber={shipment.cnNumber}
          loading={busy && fetcher.formData?.get("intent") === "cancel"}
          onClose={() => !busy && setConfirmCancel(false)}
          onConfirm={() =>
            fetcher.submit({ intent: "cancel" }, { method: "post" })
          }
        />
      )}

      {/* ── Action bar ── */}
      <s-section>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill status={hasFailed ? "FAILED" : shipment.status} />
          {shipment.leopardStatusRaw && !hasFailed && (
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
          <div className="lb-alert lb-alert-danger" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Last booking error</div>
            <div style={{ fontSize: 13, wordBreak: "break-word" }}>{shipment.lastError}</div>
          </div>
        </s-section>
      )}
      {shipment.shopifySyncStatus && shipment.shopifySyncStatus !== "SYNC_OK" && (
        <s-section>
          <div className="lb-alert lb-alert-warning" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              {shipment.shopifySyncStatus === "FAILED_PERMANENTLY"
                ? "⛔ Shopify sync failed permanently"
                : "⚠ Shopify fulfillment not synced"}
            </div>
            <div style={{ fontSize: 13 }}>
              {shipment.shopifySyncStatus === "FAILED_PERMANENTLY"
                ? `Sync has failed after maximum retry attempts. Go to Shopify Admin and manually mark order ${shipment.shopifyOrderName} as fulfilled with CN ${shipment.cnNumber}.`
                : `This shipment was booked in Leopards but Shopify was not updated (status: ${shipment.shopifySyncStatus}). A retry is scheduled.`
              }
            </div>
          </div>
        </s-section>
      )}

      {/* ── Details + Tracking side by side ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 0 }}>

        <s-section heading="Shipment details">
          <div className="lb-card"><div className="lb-card-body">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 24px" }}>
              <DetailRow label="Order"       value={shipment.shopifyOrderName} />
              <DetailRow label="CN Number"   value={shipment.cnNumber} mono />
              <DetailRow label="Consignee"   value={shipment.consigneeName} />
              <DetailRow label="Phone"       value={shipment.consigneePhone} />
              <DetailRow label="COD"         value={shipment.codAmount > 0 ? `${shipment.codAmount.toLocaleString()} PKR` : "Prepaid"} />
              <DetailRow label="Weight"      value={`${shipment.weightGrams} g`} />
              <DetailRow label="Pieces"      value={shipment.noOfPieces} />
              <DetailRow label="Origin"      value={shipment.originCityName ?? shipment.originCityId ?? "—"} />
              <DetailRow label="Destination" value={shipment.destinationCityName ?? shipment.destinationCityId ?? "—"} />
              {shipment.bookedAt    && <DetailRow label="Booked"    value={new Date(shipment.bookedAt).toLocaleString()} />}
              {shipment.deliveredAt && <DetailRow label="Delivered" value={new Date(shipment.deliveredAt).toLocaleString()} />}
              {shipment.cancelledAt && <DetailRow label="Cancelled" value={new Date(shipment.cancelledAt).toLocaleString()} />}
            </div>
            {shipment.consigneeAddress && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--lb-border-light)" }}>
                <div className="lb-section-label" style={{ marginBottom: 4 }}>Address</div>
                <div style={{ fontSize: 14, color: "var(--lb-text-secondary)" }}>{shipment.consigneeAddress}</div>
              </div>
            )}
          </div></div>
        </s-section>

        {/* ── Tracking timeline — loads async, never blocks page render ── */}
        <s-section heading="Tracking timeline">
          {!shipment.cnNumber ? (
            <div className="lb-empty">
              <span className="lb-empty-icon">📍</span>
              <div className="lb-empty-title">No CN number yet</div>
              <div className="lb-empty-desc">Book the shipment to get a tracking number.</div>
            </div>
          ) : trackingEvents === null ? (
            <div className="lb-card" style={{ padding: "0 20px" }}>
              <TrackingSkeleton />
            </div>
          ) : trackingEvents.length === 0 ? (
            <div className="lb-empty">
              <span className="lb-empty-icon">📍</span>
              <div className="lb-empty-title">No tracking events yet</div>
              {trackingError ? (
                <div style={{ fontSize: 12, color: "var(--lb-danger)", marginTop: 4 }}>{trackingError}</div>
              ) : (
                <div className="lb-empty-desc">Events will appear once the shipment is picked up.</div>
              )}
              <div style={{ marginTop: 12 }}>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="refresh" />
                  <s-button type="submit" disabled={busy} loading={busy}>Refresh tracking</s-button>
                </fetcher.Form>
              </div>
            </div>
          ) : (
            <div className="lb-card" style={{ padding: "0 20px" }}>
              {trackingEvents.map((event, i) => {
                const isFirst = i === 0;
                const isLast  = i === trackingEvents.length - 1;
                return (
                  <div key={event.id} style={{ display: "flex", gap: 14, padding: "16px 0", borderBottom: !isLast ? "1px solid var(--lb-border-light)" : "none" }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, width: 16 }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: "50%",
                        background: isFirst ? "#3d8b40" : "#c4cdd5",
                        border: `2px solid ${isFirst ? "#3d8b40" : "#c4cdd5"}`,
                        boxShadow: isFirst ? "0 0 0 3px #e3f1df" : "none",
                        marginTop: 3,
                      }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: isFirst ? 700 : 600, fontSize: 13, color: isFirst ? "#1e542a" : "#202223" }}>
                        {event.status}
                      </div>
                      {event.activityDate && (
                        <div style={{ fontSize: 12, color: "var(--lb-text-muted)", marginTop: 2 }}>{event.activityDate}</div>
                      )}
                      {event.reason && (
                        <div style={{ fontSize: 12, color: "var(--lb-text-muted)", marginTop: 2 }}>{event.reason}</div>
                      )}
                      {event.receiverName && (
                        <div style={{ fontSize: 12, color: "var(--lb-text-muted)" }}>Receiver: {event.receiverName}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </s-section>
      </div>

      {/* ── Activity log ── */}
      <s-section heading="Activity log">
        {shipment.logs.length === 0 ? (
          <div className="lb-empty" style={{ padding: "20px", textAlign: "center" }}>
            <div className="lb-empty-desc">No events recorded.</div>
          </div>
        ) : (
          <div className="lb-card">
            {shipment.logs.map((log) => (
              <div key={log.id} className="lb-list-row">
                <EventLogBadge type={log.eventType} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {log.message && <div style={{ fontSize: 13, color: "#202223" }}>{log.message}</div>}
                  {(log.fromStatus || log.toStatus) && (
                    <div style={{ fontSize: 12, color: "var(--lb-text-muted)", marginTop: 2 }}>
                      {log.fromStatus && <span>{log.fromStatus}</span>}
                      {log.fromStatus && log.toStatus && <span> → </span>}
                      {log.toStatus && <span>{log.toStatus}</span>}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--lb-text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
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
