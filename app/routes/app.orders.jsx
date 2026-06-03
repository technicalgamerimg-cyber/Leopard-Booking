import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useNavigation, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { getSettings, getCodKeywords } from "../services/settings.server";
import { listOrders } from "../services/shopify-orders.server";
import { bookOrder, bookOrdersBatch } from "../services/booking.server";

// ── Design tokens (match globals.css) ────────────────────────────────────────

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

const FINANCIAL_STATUS_STYLES = {
  PAID:               { bg: "#e3f1df", text: "#1e542a" },
  PARTIALLY_PAID:     { bg: "#eaf4fb", text: "#084e8a" },
  PENDING:            { bg: "#fff5ea", text: "#8a4b00" },
  REFUNDED:           { bg: "#f6f6f7", text: "#444750" },
  PARTIALLY_REFUNDED: { bg: "#f6f6f7", text: "#444750" },
  VOIDED:             { bg: "#f6f6f7", text: "#444750" },
};

const FINANCIAL_STATUS_LABELS = {
  PAID:               "Paid",
  PARTIALLY_PAID:     "Partial",
  PENDING:            "Pending",
  REFUNDED:           "Refunded",
  PARTIALLY_REFUNDED: "Part. refunded",
  VOIDED:             "Voided",
};

const FIELD_LABELS = {
  booked_packet_weight:         "Weight",
  booked_packet_no_piece:       "Pieces",
  booked_packet_collect_amount: "COD amount",
  origin_city:                  "Origin city",
  destination_city:             "Destination city",
  shipment_id:                  "Shipment type",
  shipment_name_eng:            "Shipper name",
  shipment_phone:               "Shipper phone",
  shipment_address:             "Shipper address",
  consignment_name_eng:         "Consignee name",
  consignment_phone:            "Consignee phone",
  consignment_address:          "Consignee address",
  special_instructions:         "Special instructions",
};

// ── Helper components ─────────────────────────────────────────────────────────

function StatusPill({ status, hasError }) {
  const key = hasError && status === "PENDING" ? "FAILED" : status;
  const s   = STATUS_STYLES[key] ?? { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: key };
  const isFailed = key === "FAILED";
  return (
    <span className="lb-pill" style={{
      background: s.bg,
      color: s.text,
      borderColor: isFailed ? s.dot : "transparent",
    }}>
      <span className="lb-pill-dot" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

function FinancialBadge({ status }) {
  const key   = status?.toUpperCase?.() ?? "";
  const style = FINANCIAL_STATUS_STYLES[key] ?? { bg: "#f6f6f7", text: "#444750" };
  const label = FINANCIAL_STATUS_LABELS[key] ?? (status ?? "—");
  return (
    <span className="lb-pill" style={{ background: style.bg, color: style.text, fontSize: 11, borderColor: "transparent" }}>
      {label}
    </span>
  );
}

function ErrorDetail({ error }) {
  const [open, setOpen] = useState(false);
  if (!error) return null;
  const short = error.length > 60 ? error.slice(0, 60) + "…" : error;
  return (
    <div style={{ marginTop: 4 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 11, color: "#d72c0d", cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{open ? "Hide error" : short}</span>
      </div>
      {open && (
        <div style={{ fontSize: 11, color: "#7f0007", background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 4, padding: "6px 8px", marginTop: 3, maxWidth: 240, wordBreak: "break-word", lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── Booking Modal (replaces inline BookingPanel) ──────────────────────────────

function BookingModal({ order, fetcher, defaultWeightGrams, defaultSpecialInstructions, hasCredentials, disabled, onClose }) {
  const [weight,       setWeight]       = useState(String(defaultWeightGrams));
  const [pieces,       setPieces]       = useState("1");
  const [cod,          setCod]          = useState(String(order.codAmount ?? 0));
  const [instructions, setInstructions] = useState(order.note || defaultSpecialInstructions || "Handle with care");
  const [errors,       setErrors]       = useState({});

  // Trap escape key to close modal
  useEffect(() => {
    const handleEsc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    document.body.classList.add("lb-modal-open");
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.classList.remove("lb-modal-open");
    };
  }, [onClose]);

  function validate() {
    const e = {};
    const w = Number(weight);
    const p = Number(pieces);
    const c = Number(cod);
    if (!Number.isFinite(w) || w <= 0) e.weight = "Must be > 0";
    if (!Number.isFinite(p) || p <= 0) e.pieces = "Must be > 0";
    if (!Number.isFinite(c) || c < 0)  e.cod    = "Cannot be negative";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    fetcher.submit(
      { orderId: order.id, overrideWeight: weight, overridePieces: pieces, overrideCod: cod, overrideInstructions: instructions },
      { method: "post", action: "/app/orders" },
    );
  }

  return (
    <div
      className="lb-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="booking-modal-title"
    >
      <div className="lb-modal lb-modal-wide">
        {/* Header */}
        <div className="lb-modal-header">
          <div>
            <div id="booking-modal-title" className="lb-modal-title">
              📦 Custom booking — {order.name}
            </div>
            <div className="lb-modal-subtitle">
              {order.customerName}
              {order.destinationCity ? ` · ${order.destinationCity}` : ""}
              {order.codAmount > 0 ? ` · COD ${order.codAmount.toLocaleString()} ${order.currency}` : " · Prepaid"}
            </div>
          </div>
          <button onClick={onClose} className="lb-modal-close" aria-label="Close">×</button>
        </div>

        {/* Body */}
        <div className="lb-modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 14 }}>
            <div className="lb-field">
              <s-text-field
                label="Weight (grams)"
                value={weight}
                onChange={(e) => setWeight(e.target?.value ?? weight)}
              />
              {errors.weight && <span className="lb-error-text">{errors.weight}</span>}
            </div>
            <div className="lb-field">
              <s-text-field
                label="Pieces"
                value={pieces}
                onChange={(e) => setPieces(e.target?.value ?? pieces)}
              />
              {errors.pieces && <span className="lb-error-text">{errors.pieces}</span>}
            </div>
            <div className="lb-field">
              <s-text-field
                label="COD amount (PKR)"
                value={cod}
                onChange={(e) => setCod(e.target?.value ?? cod)}
                helpText="0 = prepaid"
              />
              {errors.cod && <span className="lb-error-text">{errors.cod}</span>}
            </div>
          </div>
          <div style={{ marginBottom: 4 }}>
            <s-text-field
              label="Special instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target?.value ?? instructions)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="lb-modal-footer">
          <s-button onClick={onClose} disabled={disabled}>Cancel</s-button>
          <s-button
            variant="primary"
            disabled={disabled || !hasCredentials}
            loading={disabled}
            onClick={handleSubmit}
          >
            Confirm booking
          </s-button>
        </div>
      </div>
    </div>
  );
}

// ── Loader / Action ───────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const settings = await getSettings(store.id);
  const url      = new URL(request.url);
  const codKeywords = getCodKeywords(settings);

  const { orders, pageInfo } = await listOrders({
    admin,
    storeId:            store.id,
    query:              url.searchParams.get("query") ?? "",
    first:              50,
    after:              url.searchParams.get("after") ?? null,
    before:             url.searchParams.get("before") ?? null,
    defaultWeightGrams: settings.defaultWeightGrams,
    codKeywords,
  });

  return {
    orders,
    query:                      url.searchParams.get("query") ?? "",
    pageInfo,
    hasCredentials:             settings.hasCredentials,
    hasOriginCity:              Boolean(settings.originCityId),
    defaultWeightGrams:         settings.defaultWeightGrams,
    defaultSpecialInstructions: settings.defaultSpecialInstructions ?? "",
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const formData = await request.formData();
  const intent   = formData.get("intent");

  if (intent === "bookBatch") {
    let orderIds = [];
    try { orderIds = JSON.parse(String(formData.get("orderIds") ?? "[]")); } catch { orderIds = []; }
    return bookOrdersBatch({ admin, storeId: store.id, orderIds });
  }

  return bookOrder({
    admin,
    storeId: store.id,
    orderId: formData.get("orderId"),
    overrides: {
      weightGrams:         formData.get("overrideWeight"),
      noOfPieces:          formData.get("overridePieces"),
      codAmount:           formData.get("overrideCod"),
      specialInstructions: formData.get("overrideInstructions"),
    },
  });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function canBookOrder(order, hasCredentials) {
  if (!hasCredentials) return false;
  if (order.cnNumber && order.bookingStatus !== "CANCELLED") return false;
  return order.bookingStatus === "PENDING" || order.bookingStatus === "CANCELLED";
}

function buildPageQuery({ query, after, before }) {
  const p = new URLSearchParams();
  if (query) p.set("query", query);
  if (after)  p.set("after",  after);
  if (before) p.set("before", before);
  return p.toString();
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Orders() {
  const {
    orders, query, pageInfo,
    hasCredentials, hasOriginCity,
    defaultWeightGrams, defaultSpecialInstructions,
  } = useLoaderData();

  const fetcher    = useFetcher();
  const navigation = useNavigation();
  const shopify    = useAppBridge();

  const [selectedIds,       setSelectedIds]       = useState(() => new Set());
  const [bookingModalOrder, setBookingModalOrder]  = useState(null);
  const [fieldErrors,       setFieldErrors]        = useState(null);
  const [batchResults,      setBatchResults]       = useState(null);
  const prevFetcherData = useRef(null);

  const loading            = navigation.state === "loading";
  const anyBookingInFlight = fetcher.state !== "idle";
  const isBatchSubmitting  = anyBookingInFlight && fetcher.formData?.get("intent") === "bookBatch";

  useEffect(() => {
    if (!fetcher.data || fetcher.data === prevFetcherData.current) return;
    prevFetcherData.current = fetcher.data;

    if (fetcher.data.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data.fieldErrors) {
      setFieldErrors(fetcher.data.fieldErrors);
    } else {
      setFieldErrors(null);
    }
    if (fetcher.data.results) {
      setBatchResults(fetcher.data);
    }
    if (fetcher.data.ok) {
      setBookingModalOrder(null);
      if (fetcher.formData?.get("intent") === "bookBatch") setSelectedIds(new Set());
    }
  }, [fetcher.data, fetcher.formData, shopify]);

  function toggleSelection(orderId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(orderId) ? next.delete(orderId) : next.add(orderId);
      return next;
    });
  }

  const bookableOrders     = orders.filter((o) => canBookOrder(o, hasCredentials));
  const allVisibleSelected = bookableOrders.length > 0 && bookableOrders.every((o) => selectedIds.has(o.id));

  return (
    <s-page heading="Orders">

      {/* ── Booking Modal (fixed overlay, not bottom of page) ── */}
      {bookingModalOrder && (
        <BookingModal
          order={bookingModalOrder}
          fetcher={fetcher}
          defaultWeightGrams={defaultWeightGrams}
          defaultSpecialInstructions={defaultSpecialInstructions}
          hasCredentials={hasCredentials}
          disabled={anyBookingInFlight}
          onClose={() => setBookingModalOrder(null)}
        />
      )}

      {/* ── Setup warnings ── */}
      {!hasCredentials && (
        <s-section>
          <div className="lb-alert lb-alert-warning" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Setup required before booking</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>Add your Leopards credentials, test the connection, refresh cities, and set your origin city.</div>
            </div>
            <a href="/app/settings" className="lb-btn lb-btn-primary" style={{ flexShrink: 0 }}>Open Settings →</a>
          </div>
        </s-section>
      )}

      {hasCredentials && !hasOriginCity && (
        <s-section>
          <div className="lb-alert lb-alert-warning">
            <span>⚠️</span>
            <span style={{ fontSize: 13 }}>
              Origin city not set — bookings will fail until you set it.{" "}
              <a href="/app/settings" style={{ color: "#5c6ac4", fontWeight: 600 }}>Open Settings →</a>
            </span>
          </div>
        </s-section>
      )}

      {/* ── Field validation errors ── */}
      {fieldErrors && (
        <s-section>
          <div className="lb-alert lb-alert-danger" style={{ position: "relative" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Fix these issues before booking:</div>
              <ul style={{ margin: 0, paddingInlineStart: "1.25rem", display: "flex", flexDirection: "column", gap: 4 }}>
                {Object.entries(fieldErrors).map(([field, message]) => (
                  <li key={field} style={{ fontSize: 13 }}>
                    <strong>{FIELD_LABELS[field] ?? field}:</strong> {String(message)}
                  </li>
                ))}
              </ul>
            </div>
            <button onClick={() => setFieldErrors(null)} className="lb-btn lb-btn-ghost lb-btn-sm" aria-label="Dismiss">×</button>
          </div>
        </s-section>
      )}

      {/* ── Batch results ── */}
      {batchResults && (
        <s-section>
          <div
            className={batchResults.ok ? "lb-alert lb-alert-success" : "lb-alert lb-alert-danger"}
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{batchResults.message}</div>
              <button onClick={() => setBatchResults(null)} className="lb-btn lb-btn-ghost lb-btn-sm" aria-label="Dismiss">×</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {batchResults.results?.map((r) => (
                <div key={r.orderId} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
                  <span style={{ flexShrink: 0 }}>{r.ok ? "✅" : "❌"}</span>
                  <span style={{ fontWeight: 600, flexShrink: 0 }}>{r.orderName}:</span>
                  <span>{r.message}</span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      )}

      {/* ── Search ── */}
      <s-section>
        <Form method="get">
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <s-text-field label="Search orders" name="query" defaultValue={query} placeholder="Order number, customer name…" />
            </div>
            <s-button type="submit">Search</s-button>
            {query && <s-button href="/app/orders">Clear</s-button>}
          </div>
        </Form>
      </s-section>

      {/* ── Batch action bar ── */}
      {selectedIds.size > 0 && (
        <s-section>
          <div style={{
            background: "#f0f0ff",
            border: "1px solid #5c6ac4",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#3d3d8f", flex: 1 }}>
              {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""} selected
            </div>
            <s-button
              variant="primary"
              disabled={anyBookingInFlight || !hasCredentials}
              loading={isBatchSubmitting}
              onClick={() =>
                fetcher.submit(
                  { intent: "bookBatch", orderIds: JSON.stringify(Array.from(selectedIds)) },
                  { method: "post", action: "/app/orders" },
                )
              }
            >
              Book {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""}
            </s-button>
            <s-button onClick={() => setSelectedIds(new Set())} disabled={anyBookingInFlight}>
              Clear selection
            </s-button>
          </div>
        </s-section>
      )}

      {/* ── Orders table ── */}
      <s-section>
        {loading ? (
          <div style={{ padding: "48px 20px", textAlign: "center", fontSize: 13, color: "#6d7175" }}>
            Loading orders…
          </div>
        ) : orders.length === 0 ? (
          <div className="lb-empty">
            <span className="lb-empty-icon">🛒</span>
            <div className="lb-empty-title">
              {query ? `No orders matching "${query}"` : "No orders found"}
            </div>
            <div className="lb-empty-desc">
              {query ? "Try a different search term." : "Orders from your Shopify store will appear here."}
            </div>
            {query && (
              <a href="/app/orders" className="lb-btn lb-btn-primary" style={{ display: "inline-flex", marginTop: 16 }}>
                Clear search
              </a>
            )}
          </div>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>
                <s-checkbox
                  checked={allVisibleSelected}
                  onChange={() =>
                    allVisibleSelected
                      ? setSelectedIds(new Set())
                      : setSelectedIds(new Set(bookableOrders.map((o) => o.id)))
                  }
                  disabled={bookableOrders.length === 0}
                />
              </s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>City</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>COD</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => {
                const isBookable  = canBookOrder(order, hasCredentials);
                const isBooked    = Boolean(order.cnNumber) && order.bookingStatus !== "CANCELLED";
                const hasFailed   = Boolean(order.lastError) && order.bookingStatus === "PENDING";
                const thisRowBusy = anyBookingInFlight && fetcher.formData?.get("orderId") === order.id;

                return (
                  <s-table-row key={order.id}>
                    <s-table-cell>
                      <s-checkbox
                        checked={selectedIds.has(order.id)}
                        disabled={!isBookable || anyBookingInFlight}
                        onChange={() => toggleSelection(order.id)}
                      />
                    </s-table-cell>

                    <s-table-cell>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#202223" }}>{order.name}</span>
                    </s-table-cell>

                    <s-table-cell>
                      <div style={{ fontSize: 13, color: "#202223" }}>{order.customerName}</div>
                      {order.customerPhone && (
                        <div style={{ fontSize: 11, color: "#8c9196", marginTop: 1 }}>{order.customerPhone}</div>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <span style={{ fontSize: 13, color: "#444750" }}>{order.destinationCity || "—"}</span>
                    </s-table-cell>

                    <s-table-cell>
                      <FinancialBadge status={order.financialStatus} />
                    </s-table-cell>

                    <s-table-cell>
                      {order.codAmount > 0 ? (
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#202223" }}>
                          {order.codAmount.toLocaleString()}{" "}
                          <span style={{ fontWeight: 400, color: "#6d7175", fontSize: 11 }}>{order.currency}</span>
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: "#8c9196", fontStyle: "italic" }}>Prepaid</span>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <StatusPill status={order.bookingStatus} hasError={hasFailed} />
                      {hasFailed && <ErrorDetail error={order.lastError} />}
                    </s-table-cell>

                    <s-table-cell>
                      {isBooked ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {order.slipLink ? (
                            <s-link href={order.slipLink} target="_blank">
                              <span className="lb-mono" style={{ fontSize: 12 }}>{order.cnNumber}</span>
                            </s-link>
                          ) : (
                            <span className="lb-mono" style={{ fontSize: 12, color: "#444750" }}>{order.cnNumber}</span>
                          )}
                          <span style={{ fontSize: 11, color: "#8c9196" }}>CN number</span>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {/* Primary book action */}
                          <s-button
                            variant="primary"
                            size="slim"
                            disabled={anyBookingInFlight || !hasCredentials || !isBookable}
                            loading={thisRowBusy}
                            onClick={() =>
                              fetcher.submit(
                                { orderId: order.id },
                                { method: "post", action: "/app/orders" },
                              )
                            }
                          >
                            {hasFailed ? "Retry" : "Book"}
                          </s-button>

                          {/* Options button → opens modal */}
                          {isBookable && !anyBookingInFlight && (
                            <button
                              onClick={() => setBookingModalOrder(bookingModalOrder?.id === order.id ? null : order)}
                              className="lb-btn lb-btn-secondary lb-btn-sm"
                              title="Customize weight, COD, pieces"
                              aria-label="Booking options"
                            >
                              ⚙ Options
                            </button>
                          )}
                        </div>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* ── Pagination ── */}
      {orders.length > 0 && (pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
        <s-section>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <s-button
              href={pageInfo.hasPreviousPage ? `/app/orders?${buildPageQuery({ query, before: pageInfo.startCursor })}` : undefined}
              disabled={!pageInfo.hasPreviousPage}
            >
              ← Previous
            </s-button>
            <s-button
              href={pageInfo.hasNextPage ? `/app/orders?${buildPageQuery({ query, after: pageInfo.endCursor })}` : undefined}
              disabled={!pageInfo.hasNextPage}
            >
              Next →
            </s-button>
          </div>
        </s-section>
      )}

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
