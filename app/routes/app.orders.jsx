import { useEffect, useState } from "react";
import { Form, useFetcher, useLoaderData, useNavigation, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { getSettings, getCodKeywords } from "../services/settings.server";
import { listOrders } from "../services/shopify-orders.server";
import { bookOrder, bookOrdersBatch } from "../services/booking.server";

const STATUS_STYLES = {
  PENDING:    { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00", label: "Not booked" },
  BOOKED:     { dot: "#2c6ecb", bg: "#eaf4fb", text: "#0d3880", label: "Booked" },
  IN_TRANSIT: { dot: "#5c6ac4", bg: "#f0f0ff", text: "#3d3d8f", label: "In transit" },
  DELIVERED:  { dot: "#3d8b40", bg: "#e3f1df", text: "#1e542a", label: "Delivered" },
  RETURNED:   { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00", label: "Returned" },
  CANCELLED:  { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: "Cancelled" },
  EXCEPTION:  { dot: "#d72c0d", bg: "#fce8e7", text: "#7f0007", label: "Exception" },
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

const FINANCIAL_STATUS_STYLES = {
  PAID:                { bg: "#e3f1df", text: "#1e542a" },
  PARTIALLY_PAID:      { bg: "#eaf4fb", text: "#084e8a" },
  PENDING:             { bg: "#fff5ea", text: "#8a4b00" },
  REFUNDED:            { bg: "#f6f6f7", text: "#444750" },
  PARTIALLY_REFUNDED:  { bg: "#f6f6f7", text: "#444750" },
  VOIDED:              { bg: "#f6f6f7", text: "#444750" },
};

const FINANCIAL_STATUS_LABELS = {
  PAID:               "Paid",
  PARTIALLY_PAID:     "Partial",
  PENDING:            "Pending",
  REFUNDED:           "Refunded",
  PARTIALLY_REFUNDED: "Part. refunded",
  VOIDED:             "Voided",
};

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: status };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 12, background: s.bg, color: s.text, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

function FinancialBadge({ status }) {
  const key = status?.toUpperCase?.() ?? "";
  const style = FINANCIAL_STATUS_STYLES[key] ?? { bg: "#f6f6f7", text: "#444750" };
  const label = FINANCIAL_STATUS_LABELS[key] ?? (status ?? "—");
  return (
    <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: style.bg, color: style.text, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const settings = await getSettings(store.id);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const after = url.searchParams.get("after") ?? null;
  const before = url.searchParams.get("before") ?? null;
  const codKeywords = getCodKeywords(settings);

  const { orders, pageInfo } = await listOrders({
    admin,
    storeId: store.id,
    query,
    first: 50,
    after,
    before,
    defaultWeightGrams: settings.defaultWeightGrams,
    codKeywords,
  });

  return {
    orders,
    query,
    pageInfo,
    hasCredentials: settings.hasCredentials,
    hasOriginCity: Boolean(settings.originCityId),
    defaultWeightGrams: settings.defaultWeightGrams,
    defaultSpecialInstructions: settings.defaultSpecialInstructions ?? "",
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

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

function canBookOrder(order, hasCredentials) {
  if (!hasCredentials) return false;
  if (order.cnNumber) return false;
  if (order.bookingStatus === "CANCELLED") return true;
  return order.bookingStatus === "PENDING";
}

function buildPageQuery({ query, after, before }) {
  const p = new URLSearchParams();
  if (query) p.set("query", query);
  if (after) p.set("after", after);
  if (before) p.set("before", before);
  return p.toString();
}

function BookingPanel({ order, fetcher, defaultWeightGrams, defaultSpecialInstructions, hasCredentials, onClose }) {
  const [weight, setWeight] = useState(String(defaultWeightGrams));
  const [pieces, setPieces] = useState("1");
  const [cod, setCod] = useState(String(order.codAmount ?? 0));
  const [instructions, setInstructions] = useState(order.note || defaultSpecialInstructions || "Handle with care");

  const busy = fetcher.state !== "idle" && fetcher.formData?.get("orderId") === order.id;

  function handleSubmit() {
    fetcher.submit(
      { orderId: order.id, overrideWeight: weight, overridePieces: pieces, overrideCod: cod, overrideInstructions: instructions },
      { method: "post", action: "/app/orders" },
    );
  }

  return (
    <div style={{ background: "#f9fafb", border: "1px solid #c9cccf", borderRadius: 8, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#202223" }}>
            Custom booking — {order.name}
          </div>
          <div style={{ fontSize: 13, color: "#6d7175", marginTop: 3 }}>
            {order.customerName}
            {order.destinationCity ? ` · ${order.destinationCity}` : ""}
            {order.codAmount > 0 ? ` · COD ${order.codAmount} ${order.currency}` : " · Prepaid"}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: "#6d7175", padding: "0 4px", lineHeight: 1 }}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 12 }}>
        <s-text-field
          label="Weight (grams)"
          value={weight}
          onChange={(e) => setWeight(e.target?.value ?? e.currentTarget?.value ?? weight)}
        />
        <s-text-field
          label="Pieces"
          value={pieces}
          onChange={(e) => setPieces(e.target?.value ?? e.currentTarget?.value ?? pieces)}
        />
        <s-text-field
          label="COD amount (PKR)"
          value={cod}
          onChange={(e) => setCod(e.target?.value ?? e.currentTarget?.value ?? cod)}
          helpText="Set 0 for prepaid orders"
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <s-text-field
          label="Special instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target?.value ?? e.currentTarget?.value ?? instructions)}
        />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <s-button
          variant="primary"
          disabled={busy || !hasCredentials}
          loading={busy}
          onClick={handleSubmit}
        >
          Confirm booking
        </s-button>
        <s-button onClick={onClose} disabled={busy}>Cancel</s-button>
      </div>
    </div>
  );
}

export default function Orders() {
  const {
    orders,
    query,
    pageInfo,
    hasCredentials,
    hasOriginCity,
    defaultWeightGrams,
    defaultSpecialInstructions,
  } = useLoaderData();

  const fetcher = useFetcher();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bookingPanelOrder, setBookingPanelOrder] = useState(null);
  const [fieldErrors, setFieldErrors] = useState(null);

  const loading = navigation.state === "loading";
  const submittingOrderId = fetcher.state !== "idle" ? fetcher.formData?.get("orderId") : null;
  const isBatchSubmitting = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "bookBatch";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data.fieldErrors) {
      setFieldErrors(fetcher.data.fieldErrors);
    } else {
      setFieldErrors(null);
    }
    if (fetcher.data.ok) {
      setBookingPanelOrder(null);
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

  const bookableOrders = orders.filter((o) => canBookOrder(o, hasCredentials));
  const allVisibleSelected = bookableOrders.length > 0 && bookableOrders.every((o) => selectedIds.has(o.id));
  const batchResults = fetcher.data?.results ?? null;

  return (
    <s-page heading="Orders">

      {/* ── Setup warnings ── */}
      {!hasCredentials && (
        <s-section>
          <div style={{ background: "#fff8ec", border: "1px solid #e8912d", borderRadius: 8, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#5c3500" }}>Setup required before booking</div>
              <div style={{ fontSize: 13, color: "#8a4b00", marginTop: 2 }}>
                Add your Leopards API credentials, test the connection, refresh cities, and set your origin city.
              </div>
            </div>
            <a href="/app/settings" style={{ padding: "7px 14px", background: "#e8912d", color: "#fff", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
              Open Settings →
            </a>
          </div>
        </s-section>
      )}

      {hasCredentials && !hasOriginCity && (
        <s-section>
          <div style={{ background: "#fff8ec", border: "1px solid #e8912d", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#8a4b00" }}>
            ⚠️ Origin city not set. <a href="/app/settings" style={{ color: "#5c6ac4", fontWeight: 600 }}>Open Settings →</a>
          </div>
        </s-section>
      )}

      {/* ── Field validation errors ── */}
      {fieldErrors && (
        <s-section>
          <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 8, padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#7f0007", marginBottom: 8 }}>
                  Fix these issues before booking:
                </div>
                <ul style={{ margin: 0, paddingInlineStart: "1.25rem", display: "flex", flexDirection: "column", gap: 4 }}>
                  {Object.entries(fieldErrors).map(([field, message]) => (
                    <li key={field} style={{ fontSize: 13, color: "#7f0007" }}>
                      <strong>{FIELD_LABELS[field] ?? field}:</strong> {String(message)}
                    </li>
                  ))}
                </ul>
              </div>
              <button onClick={() => setFieldErrors(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#7f0007", padding: "0 4px", flexShrink: 0 }}>×</button>
            </div>
          </div>
        </s-section>
      )}

      {/* ── Batch results ── */}
      {batchResults && (
        <s-section>
          <div style={{ background: fetcher.data?.ok ? "#e3f1df" : "#fce8e7", border: `1px solid ${fetcher.data?.ok ? "#3d8b40" : "#d72c0d"}`, borderRadius: 8, padding: "14px 18px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: fetcher.data?.ok ? "#1e542a" : "#7f0007", marginBottom: 8 }}>
              {fetcher.data?.message}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {batchResults.map((r) => (
                <div key={r.orderId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ fontSize: 14 }}>{r.ok ? "✅" : "❌"}</span>
                  <span style={{ fontWeight: 600, color: "#202223" }}>{r.orderName}:</span>
                  <span style={{ color: "#6d7175" }}>{r.message}</span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      )}

      {/* ── Search bar — uses plain Form (GET) separate from the POST fetcher ── */}
      <s-section>
        <Form method="get">
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <s-text-field
                label="Search orders"
                name="query"
                defaultValue={query}
                placeholder="Order number, customer name…"
              />
            </div>
            <s-button type="submit">Search</s-button>
            {query && <s-button href="/app/orders">Clear</s-button>}
          </div>
        </Form>
      </s-section>

      {/* ── Batch action bar ── */}
      {selectedIds.size > 0 && (
        <s-section>
          <div style={{ background: "#f0f0ff", border: "1px solid #5c6ac4", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#3d3d8f" }}>
              {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""} selected
            </div>
            <s-button
              variant="primary"
              disabled={isBatchSubmitting || !hasCredentials}
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
            <s-button onClick={() => setSelectedIds(new Set())} disabled={isBatchSubmitting}>
              Clear selection
            </s-button>
          </div>
        </s-section>
      )}

      {/* ── Orders table ── */}
      <s-section>
        {loading ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "#6d7175" }}>Loading orders…</div>
          </div>
        ) : orders.length === 0 ? (
          <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "48px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🛒</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#202223", marginBottom: 4 }}>
              {query ? `No orders matching "${query}"` : "No orders found"}
            </div>
            <div style={{ fontSize: 13, color: "#6d7175" }}>
              {query ? "Try a different search term or clear the filter." : "Orders from your Shopify store will appear here."}
            </div>
            {query && (
              <a href="/app/orders" style={{ display: "inline-block", marginTop: 12, padding: "7px 16px", background: "#5c6ac4", color: "#fff", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
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
                const isSubmitting = submittingOrderId === order.id;
                const isBookable = canBookOrder(order, hasCredentials);
                const isBooked = Boolean(order.cnNumber);

                return (
                  <s-table-row key={order.id}>
                    <s-table-cell>
                      <s-checkbox
                        checked={selectedIds.has(order.id)}
                        disabled={!isBookable}
                        onChange={() => toggleSelection(order.id)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <span style={{ fontWeight: 600, fontSize: 13, color: "#202223" }}>{order.name}</span>
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
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#202223" }}>
                          {order.codAmount.toLocaleString()} <span style={{ fontWeight: 400, color: "#6d7175" }}>{order.currency}</span>
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: "#8c9196" }}>Prepaid</span>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <StatusPill status={order.bookingStatus} />
                        {order.lastError && (
                          <div style={{ fontSize: 11, color: "#d72c0d", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={order.lastError}>
                            {order.lastError}
                          </div>
                        )}
                      </div>
                    </s-table-cell>
                    <s-table-cell>
                      {isBooked ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          {order.slipLink ? (
                            <s-link href={order.slipLink} target="_blank">
                              {order.cnNumber}
                            </s-link>
                          ) : (
                            <span style={{ fontSize: 12, fontFamily: "monospace", color: "#444750" }}>{order.cnNumber}</span>
                          )}
                          <span style={{ fontSize: 11, color: "#8c9196" }}>CN number</span>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <s-button
                            variant="primary"
                            disabled={isSubmitting || !hasCredentials}
                            loading={isSubmitting}
                            onClick={() =>
                              fetcher.submit(
                                { orderId: order.id },
                                { method: "post", action: "/app/orders" },
                              )
                            }
                          >
                            Book
                          </s-button>
                          {isBookable && (
                            <button
                              onClick={() => setBookingPanelOrder(bookingPanelOrder?.id === order.id ? null : order)}
                              style={{ background: "none", border: "1px solid #c9cccf", borderRadius: 5, padding: "5px 8px", cursor: "pointer", fontSize: 12, color: "#444750", whiteSpace: "nowrap" }}
                            >
                              Options
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

      {/* ── Booking panel ── */}
      {bookingPanelOrder && (
        <s-section heading={`Custom booking options — ${bookingPanelOrder.name}`}>
          <BookingPanel
            order={bookingPanelOrder}
            fetcher={fetcher}
            defaultWeightGrams={defaultWeightGrams}
            defaultSpecialInstructions={defaultSpecialInstructions}
            hasCredentials={hasCredentials}
            onClose={() => setBookingPanelOrder(null)}
          />
        </s-section>
      )}

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
