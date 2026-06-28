import { useEffect, useRef, useState } from "react";
import {
  Form, Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import {
  cancelShipments, listShipments,
  refreshShipmentStatuses, refreshShipmentStatusesByDateRange,
} from "../services/shipment.server";
import { batchResolveCityNames } from "../services/city.server";
import db from "../db.server";

const ALL_STATUSES = ["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"];

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

const TERMINAL_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED"];

function daysAgoYMD(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ── Loader / Action ───────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url   = new URL(request.url);
  const status  = url.searchParams.get("status") ?? "";
  const query   = url.searchParams.get("query") ?? "";
  const page    = Number(url.searchParams.get("page") ?? "1");
  const limit   = 50;

  const [{ shipments, total, pageCount }, statusCountRows] = await Promise.all([
    listShipments(store.id, status, query, page, limit),
    db.shipment.groupBy({ by: ["status"], where: { storeId: store.id }, _count: { _all: true } }),
  ]);

  const VISIBLE = new Set(["BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED"]);
  const statusCounts = { ALL: 0 };
  for (const row of statusCountRows) {
    statusCounts[row.status] = row._count._all;
    if (VISIBLE.has(row.status)) statusCounts.ALL += row._count._all;
  }

  const cityIdList = [];
  for (const s of shipments) {
    if (s.originCityId)      cityIdList.push(s.originCityId);
    if (s.destinationCityId) cityIdList.push(s.destinationCityId);
  }
  const cityNameMap = await batchResolveCityNames(store.id, cityIdList);
  const cityNames   = Object.fromEntries([...cityNameMap.entries()].map(([id, name]) => [id, name ?? String(id)]));

  return {
    status, query, page, pageCount, total, perPage: limit,
    cityNames, statusCounts,
    defaultFromDate: daysAgoYMD(7),
    defaultToDate:   daysAgoYMD(0),
    shipments: shipments.map((s) => ({
      ...s,
      createdAt:   s.createdAt.toISOString(),
      updatedAt:   s.updatedAt.toISOString(),
      bookedAt:    s.bookedAt?.toISOString() ?? null,
      deliveredAt: s.deliveredAt?.toISOString() ?? null,
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
    })),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const store    = await ensureStore(session);
  const formData = await request.formData();
  const intent   = formData.get("intent");

  const cnNumbers = String(formData.get("cnNumbers") ?? "")
    .split(",").map((v) => v.trim()).filter(Boolean);

  if (intent === "refresh")    return { ...await refreshShipmentStatuses(store.id, cnNumbers), intent };
  if (intent === "refreshAll") return { ...await refreshShipmentStatuses(store.id, []), intent };
  if (intent === "refreshByDate") {
    const fromDate = String(formData.get("fromDate") ?? "").trim();
    const toDate   = String(formData.get("toDate")   ?? "").trim();
    if (!fromDate || !toDate) return { ok: false, message: "Both dates are required.", intent };
    return { ...await refreshShipmentStatusesByDateRange(store.id, fromDate, toDate), intent };
  }
  if (intent === "cancel" || intent === "cancelBatch") {
    return { ...await cancelShipments(store.id, cnNumbers, admin), intent };
  }
  return { ok: false, message: "Unknown action.", intent };
};

// ── Helper components ─────────────────────────────────────────────────────────

function StatusPill({ status, hasError }) {
  const key = hasError && status === "PENDING" ? "FAILED" : status;
  const s   = STATUS_STYLES[key] ?? { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: key };
  return (
    <span className="lb-pill" style={{
      background: s.bg,
      color: s.text,
      borderColor: key === "FAILED" ? s.dot : "transparent",
    }}>
      <span className="lb-pill-dot" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

function buildPageQuery({ status, query, page }) {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (query)  p.set("query",  query);
  if (page > 1) p.set("page", String(page));
  return p.toString();
}

// ── Cancel Confirmation Modal ─────────────────────────────────────────────────

function CancelModal({ title, message, onConfirm, onClose, loading }) {
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
            <div className="lb-modal-title" style={{ color: "#7f0007" }}>⚠️ {title}</div>
          </div>
          <button onClick={onClose} className="lb-modal-close" disabled={loading} aria-label="Close">×</button>
        </div>
        <div className="lb-modal-body">
          <p style={{ fontSize: 14, color: "#444750", margin: 0, lineHeight: 1.6 }}>{message}</p>
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Shipments() {
  const {
    shipments, status, query, page, pageCount, total, perPage,
    cityNames, statusCounts, defaultFromDate, defaultToDate,
  } = useLoaderData();

  const fetcher    = useFetcher();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify    = useAppBridge();

  const [cancelTarget,       setCancelTarget]       = useState(null);  // single CN
  const [selectedCns,        setSelectedCns]        = useState(() => new Set());
  const [batchCancelConfirm, setBatchCancelConfirm] = useState(false);
  const [fromDate,           setFromDate]           = useState(defaultFromDate);
  const [toDate,             setToDate]             = useState(defaultToDate);
  const prevFetcherData = useRef(null);

  const loading         = navigation.state === "loading";
  const submittingCn    = fetcher.state !== "idle" ? fetcher.formData?.get("cnNumbers") : null;
  const isRefreshAll    = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refreshAll";
  const isRefreshByDate = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refreshByDate";
  const isBatchCancel   = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "cancelBatch";
  const isSingleCancel  = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "cancel";

  useEffect(() => {
    if (!fetcher.data || fetcher.data === prevFetcherData.current) return;
    prevFetcherData.current = fetcher.data;

    if (fetcher.data.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data.ok) {
      const intent = fetcher.data.intent;
      revalidator.revalidate();
      if (intent === "cancelBatch") { setSelectedCns(new Set()); setBatchCancelConfirm(false); }
      if (intent === "cancel")      setCancelTarget(null);
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCn(cn) {
    setSelectedCns((prev) => { const n = new Set(prev); n.has(cn) ? n.delete(cn) : n.add(cn); return n; });
  }

  const selectableShipments   = shipments.filter((s) => s.cnNumber && !TERMINAL_STATUSES.includes(s.status));
  const allSelectableSelected = selectableShipments.length > 0 && selectableShipments.every((s) => selectedCns.has(s.cnNumber));

  const startCount = total === 0 ? 0 : (page - 1) * perPage + 1;
  const endCount   = Math.min(page * perPage, total);

  return (
    <s-page heading="Shipments">

      {/* ── Cancel Modals (centered overlays, not inline sections) ── */}
      {cancelTarget && (
        <CancelModal
          title={`Cancel shipment ${cancelTarget}?`}
          message="This will cancel the shipment with Leopards Courier and remove the tracking info from Shopify. This action cannot be undone."
          loading={isSingleCancel}
          onClose={() => !isSingleCancel && setCancelTarget(null)}
          onConfirm={() =>
            fetcher.submit(
              { intent: "cancel", cnNumbers: cancelTarget },
              { method: "post", action: "/app/shipments" },
            )
          }
        />
      )}

      {batchCancelConfirm && (
        <CancelModal
          title={`Cancel ${selectedCns.size} shipment${selectedCns.size !== 1 ? "s" : ""}?`}
          message={`This will cancel all ${selectedCns.size} selected shipments with Leopards Courier and remove their tracking info from Shopify. This action cannot be undone.`}
          loading={isBatchCancel}
          onClose={() => !isBatchCancel && setBatchCancelConfirm(false)}
          onConfirm={() => {
            setBatchCancelConfirm(false);
            fetcher.submit(
              { intent: "cancelBatch", cnNumbers: Array.from(selectedCns).join(",") },
              { method: "post", action: "/app/shipments" },
            );
          }}
        />
      )}

      {/* ── Status tabs ── */}
      <s-section>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            { key: "", label: "All", count: statusCounts.ALL },
            ...ALL_STATUSES.map((s) => ({ key: s, label: STATUS_STYLES[s]?.label ?? s, count: statusCounts[s] ?? 0 })),
          ].map(({ key, label, count }) => {
            const isActive = status === key;
            const style    = STATUS_STYLES[key];
            return (
              <Link
                key={key}
                to={`/app/shipments?${buildPageQuery({ status: key, query, page: 1 })}`}
                className={`lb-tab${isActive ? " lb-tab-active" : ""}`}
                style={{
                  background:  isActive ? (style?.bg ?? "#f0f0ff") : "#f6f6f7",
                  color:       isActive ? (style?.text ?? "#3d3d8f") : "#444750",
                  borderColor: isActive ? (style?.dot ?? "#5c6ac4") : "transparent",
                }}
              >
                {key && style && <span className="lb-pill-dot" style={{ background: style.dot }} />}
                {label}
                {count > 0 && (
                  <span
                    className="lb-tab-count"
                    style={{
                      background: isActive ? (style?.dot ?? "#5c6ac4") : "#e1e3e5",
                      color:      isActive ? "#fff" : "#444750",
                    }}
                  >
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {/* Search row */}
        <Form method="get" style={{ display: "contents" }}>
          <input type="hidden" name="status" value={status} />
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <s-text-field label="Search" name="query" defaultValue={query} placeholder="CN number, order name, consignee…" />
            </div>
            <s-button type="submit">Search</s-button>
            {(status || query) && <s-button href="/app/shipments">Clear</s-button>}
          </div>
        </Form>
      </s-section>

      {/* ── Sync tools ── */}
      <s-section>
        <div className="lb-card">
          <div className="lb-card-header">
            <span className="lb-section-label">Status synchronisation</span>
          </div>
          <div className="lb-card-body">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              {/* Sync all active */}
              <div>
                <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 6 }}>Sync all active shipments</div>
                <s-button
                  variant="primary"
                  disabled={isRefreshAll}
                  loading={isRefreshAll}
                  onClick={() => fetcher.submit({ intent: "refreshAll" }, { method: "post", action: "/app/shipments" })}
                >
                  Sync all statuses
                </s-button>
              </div>

              <div style={{ width: 1, background: "#e1e3e5", alignSelf: "stretch", margin: "0 4px" }} />

              {/* Sync by date range */}
              <div>
                <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 6 }}>Sync by booking date range</div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 140 }}>
                    <s-text-field
                      label="From"
                      type="date"
                      value={fromDate}
                      onChange={(e) => setFromDate(e.target?.value ?? e.currentTarget?.value ?? fromDate)}
                    />
                  </div>
                  <div style={{ minWidth: 140 }}>
                    <s-text-field
                      label="To"
                      type="date"
                      value={toDate}
                      onChange={(e) => setToDate(e.target?.value ?? e.currentTarget?.value ?? toDate)}
                    />
                  </div>
                  <s-button
                    disabled={isRefreshByDate}
                    loading={isRefreshByDate}
                    onClick={() => fetcher.submit({ intent: "refreshByDate", fromDate, toDate }, { method: "post", action: "/app/shipments" })}
                  >
                    Sync range
                  </s-button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </s-section>

      {/* ── Batch action bar ── */}
      {selectedCns.size > 0 && (
        <s-section>
          <div style={{
            background: "#fff5f5",
            border: "1px solid #fca5a5",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#7f0007", flex: 1 }}>
              {selectedCns.size} shipment{selectedCns.size !== 1 ? "s" : ""} selected
            </div>
            <s-button
              tone="critical"
              disabled={isBatchCancel}
              loading={isBatchCancel}
              onClick={() => setBatchCancelConfirm(true)}
            >
              Cancel {selectedCns.size} shipment{selectedCns.size !== 1 ? "s" : ""}
            </s-button>
            <s-button onClick={() => setSelectedCns(new Set())} disabled={isBatchCancel}>
              Clear selection
            </s-button>
          </div>
        </s-section>
      )}

      {/* ── Table ── */}
      <s-section>
        {loading ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "#6d7175", fontSize: 13 }}>
            Loading shipments…
          </div>
        ) : shipments.length === 0 ? (
          <div className="lb-empty">
            <span className="lb-empty-icon">📭</span>
            <div className="lb-empty-title">
              {status || query ? "No shipments match this filter" : "No shipments yet"}
            </div>
            <div className="lb-empty-desc">
              {status && `Filtered by: ${STATUS_STYLES[status]?.label ?? status}.`}
              {query && ` Searching: "${query}".`}
              {!status && !query && "Booked orders will appear here."}
            </div>
            {(status || query) && (
              <Link to="/app/shipments" className="lb-btn lb-btn-primary" style={{ display: "inline-flex", marginTop: 16 }}>
                Clear filters
              </Link>
            )}
          </div>
        ) : (
          <>
            {/* Record count row */}
            <div style={{ fontSize: 12, color: "#8c9196", marginBottom: 8, paddingLeft: 2 }}>
              Showing {startCount}–{endCount} of {total} shipment{total !== 1 ? "s" : ""}
            </div>
            <s-table>
              <s-table-header-row>
                <s-table-header>
                  <s-checkbox
                    checked={allSelectableSelected}
                    onChange={() => allSelectableSelected
                      ? setSelectedCns(new Set())
                      : setSelectedCns(new Set(selectableShipments.map((s) => s.cnNumber)))
                    }
                    disabled={selectableShipments.length === 0}
                  />
                </s-table-header>
                <s-table-header>Order</s-table-header>
                <s-table-header>CN Number</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Consignee</s-table-header>
                <s-table-header>Destination</s-table-header>
                <s-table-header>COD</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {shipments.map((shipment) => {
                  const isThisRowBusy = submittingCn === shipment.cnNumber;
                  const isTerminal    = TERMINAL_STATUSES.includes(shipment.status);
                  const isSelectable  = shipment.cnNumber && !isTerminal;
                  const hasFailed     = Boolean(shipment.lastError) && shipment.status === "PENDING";
                  const relevantDate  = shipment.deliveredAt ?? shipment.cancelledAt ?? shipment.bookedAt;

                  return (
                    <s-table-row key={shipment.id}>
                      <s-table-cell>
                        <s-checkbox
                          checked={selectedCns.has(shipment.cnNumber)}
                          disabled={!isSelectable}
                          onChange={() => toggleCn(shipment.cnNumber)}
                        />
                      </s-table-cell>

                      <s-table-cell>
                        <s-link href={`/app/shipments/${shipment.id}`}>
                          <span style={{ fontWeight: 600 }}>{shipment.shopifyOrderName}</span>
                        </s-link>
                      </s-table-cell>

                      <s-table-cell>
                        {shipment.slipLink ? (
                          <s-link href={shipment.slipLink} target="_blank">
                            <span className="lb-mono" style={{ fontSize: 13 }}>{shipment.cnNumber}</span>
                          </s-link>
                        ) : (
                          <span className="lb-mono" style={{ fontSize: 13, color: shipment.cnNumber ? "#202223" : "#8c9196" }}>
                            {shipment.cnNumber || "—"}
                          </span>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <div>
                          <StatusPill status={shipment.status} hasError={hasFailed} />
                          {shipment.leopardStatusRaw && !hasFailed && (
                            <div style={{ fontSize: 11, color: "#8c9196", marginTop: 2 }}>{shipment.leopardStatusRaw}</div>
                          )}
                          {hasFailed && (
                            <div
                              style={{ fontSize: 11, color: "#d72c0d", marginTop: 3, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                              title={shipment.lastError}
                            >
                              {shipment.lastError}
                            </div>
                          )}
                          {shipment.writebackFailed && shipment.status === "BOOKED" && (
                            <div style={{ fontSize: 11, color: "#b7831a", marginTop: 3, fontWeight: 600 }}>⚠ Shopify sync failed</div>
                          )}
                        </div>
                      </s-table-cell>

                      <s-table-cell>
                        <div style={{ fontSize: 13, color: "#202223" }}>{shipment.consigneeName}</div>
                        {shipment.consigneePhone && (
                          <div style={{ fontSize: 11, color: "#8c9196", marginTop: 1 }}>{shipment.consigneePhone}</div>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <span style={{ fontSize: 13, color: "#444750" }}>
                          {shipment.destinationCityId
                            ? cityNames[shipment.destinationCityId] ?? shipment.destinationCityId
                            : "—"}
                        </span>
                      </s-table-cell>

                      <s-table-cell>
                        {shipment.codAmount > 0 ? (
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#202223" }}>
                            {shipment.codAmount.toLocaleString()}
                          </span>
                        ) : (
                          <span style={{ fontSize: 12, color: "#8c9196", fontStyle: "italic" }}>—</span>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        {relevantDate ? (
                          <div>
                            <div style={{ fontSize: 13, color: "#202223" }}>
                              {new Date(relevantDate).toLocaleDateString()}
                            </div>
                            <div style={{ fontSize: 11, color: "#8c9196" }}>
                              {shipment.deliveredAt ? "delivered" : shipment.cancelledAt ? "cancelled" : "booked"}
                            </div>
                          </div>
                        ) : "—"}
                      </s-table-cell>

                      <s-table-cell>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <s-button href={`/app/shipments/${shipment.id}`}>View</s-button>
                          {!isTerminal && shipment.cnNumber && (
                            <s-button
                              tone="critical"
                              disabled={isThisRowBusy}
                              loading={isThisRowBusy}
                              onClick={() => setCancelTarget(shipment.cnNumber)}
                            >
                              Cancel
                            </s-button>
                          )}
                        </div>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-section>

      {/* ── Pagination ── */}
      {shipments.length > 0 && pageCount > 1 && (
        <s-section>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <s-button
              href={page > 1 ? `/app/shipments?${buildPageQuery({ status, query, page: page - 1 })}` : undefined}
              disabled={page <= 1}
            >
              ← Previous
            </s-button>
            <span style={{ fontSize: 13, color: "#6d7175" }}>{startCount}–{endCount} of {total}</span>
            <s-button
              href={page < pageCount ? `/app/shipments?${buildPageQuery({ status, query, page: page + 1 })}` : undefined}
              disabled={page >= pageCount}
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
