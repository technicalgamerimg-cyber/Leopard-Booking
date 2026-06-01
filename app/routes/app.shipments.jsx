import { useEffect, useState } from "react";
import {
  Form,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import {
  cancelShipments,
  listShipments,
  refreshShipmentStatuses,
  refreshShipmentStatusesByDateRange,
} from "../services/shipment.server";
import { batchResolveCityNames } from "../services/city.server";
import db from "../db.server";

const ALL_STATUSES = ["PENDING", "BOOKED", "IN_TRANSIT", "DELIVERED", "RETURNED", "CANCELLED", "EXCEPTION"];

const STATUS_STYLES = {
  PENDING:    { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00",  label: "Not booked" },
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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const query = url.searchParams.get("query") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");
  const limit = 50;

  const [{ shipments, total, pageCount }, statusCountRows] = await Promise.all([
    listShipments(store.id, status, query, page, limit),
    db.shipment.groupBy({ by: ["status"], where: { storeId: store.id }, _count: { _all: true } }),
  ]);

  const statusCounts = { ALL: 0 };
  for (const row of statusCountRows) {
    statusCounts[row.status] = row._count._all;
    statusCounts.ALL += row._count._all;
  }

  const cityIdList = [];
  for (const s of shipments) {
    if (s.originCityId) cityIdList.push(s.originCityId);
    if (s.destinationCityId) cityIdList.push(s.destinationCityId);
  }
  const cityNameMap = await batchResolveCityNames(store.id, cityIdList);
  const cityNames = Object.fromEntries(
    [...cityNameMap.entries()].map(([id, name]) => [id, name ?? String(id)]),
  );

  return {
    status,
    query,
    page,
    pageCount,
    total,
    perPage: limit,
    cityNames,
    statusCounts,
    defaultFromDate: daysAgoYMD(7),
    defaultToDate: daysAgoYMD(0),
    shipments: shipments.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      bookedAt: s.bookedAt?.toISOString() ?? null,
      deliveredAt: s.deliveredAt?.toISOString() ?? null,
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const cnNumbers = String(formData.get("cnNumbers") ?? "")
    .split(",").map((v) => v.trim()).filter(Boolean);

  if (intent === "refresh")    return { ...await refreshShipmentStatuses(store.id, cnNumbers),  intent };
  if (intent === "refreshAll") return { ...await refreshShipmentStatuses(store.id, []),         intent };
  if (intent === "refreshByDate") {
    const fromDate = String(formData.get("fromDate") ?? "").trim();
    const toDate   = String(formData.get("toDate")   ?? "").trim();
    if (!fromDate || !toDate) return { ok: false, message: "Both dates are required.", intent };
    return { ...await refreshShipmentStatusesByDateRange(store.id, fromDate, toDate), intent };
  }
  if (intent === "cancel" || intent === "cancelBatch") {
    return { ...await cancelShipments(store.id, cnNumbers), intent };
  }
  return { ok: false, message: "Unknown action.", intent };
};

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: status };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 12, background: s.bg, color: s.text, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
      {s.label}
    </span>
  );
}

function buildPageQuery({ status, query, page }) {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (query) p.set("query", query);
  if (page > 1) p.set("page", String(page));
  return p.toString();
}

export default function Shipments() {
  const {
    shipments, status, query, page, pageCount, total, perPage,
    cityNames, statusCounts, defaultFromDate, defaultToDate,
  } = useLoaderData();

  const fetcher = useFetcher();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [cancelTarget, setCancelTarget]             = useState(null);
  const [selectedCns, setSelectedCns]               = useState(() => new Set());
  const [batchCancelConfirm, setBatchCancelConfirm] = useState(false);
  const [showSyncPanel, setShowSyncPanel]           = useState(false);
  const [fromDate, setFromDate]                     = useState(defaultFromDate);
  const [toDate, setToDate]                         = useState(defaultToDate);

  const loading         = navigation.state === "loading";
  const submittingCn    = fetcher.state !== "idle" ? fetcher.formData?.get("cnNumbers") : null;
  const isRefreshAll    = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refreshAll";
  const isRefreshByDate = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refreshByDate";
  const isBatchCancel   = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "cancelBatch";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
    if (fetcher.data.ok) {
      const intent = fetcher.data.intent;
      // Revalidate loader so the table shows fresh statuses after any successful action.
      revalidator.revalidate();
      if (intent === "cancelBatch") { setSelectedCns(new Set()); setBatchCancelConfirm(false); }
      if (intent === "cancel")      setCancelTarget(null);
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCn(cn) {
    setSelectedCns((prev) => { const n = new Set(prev); n.has(cn) ? n.delete(cn) : n.add(cn); return n; });
  }

  const selectableShipments = shipments.filter((s) => s.cnNumber && !TERMINAL_STATUSES.includes(s.status));
  const allSelectableSelected = selectableShipments.length > 0 && selectableShipments.every((s) => selectedCns.has(s.cnNumber));

  const exportHref = `/app/shipments/export?${new URLSearchParams({ ...(status ? { status } : {}), ...(query ? { query } : {}) })}`;
  const startCount = total === 0 ? 0 : (page - 1) * perPage + 1;
  const endCount   = Math.min(page * perPage, total);

  return (
    <s-page heading="Shipments">

      {/* ── Status tabs with counts ── */}
      <s-section>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
          {[{ key: "", label: "All", count: statusCounts.ALL }, ...ALL_STATUSES.map((s) => ({ key: s, label: STATUS_STYLES[s]?.label ?? s, count: statusCounts[s] ?? 0 }))].map(({ key, label, count }) => {
            const isActive = status === key;
            const style = STATUS_STYLES[key];
            return (
              <a
                key={key}
                href={`/app/shipments?${buildPageQuery({ status: key, query, page: 1 })}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: isActive ? 700 : 500,
                  textDecoration: "none",
                  background: isActive ? (style?.bg ?? "#f0f0ff") : "#f6f6f7",
                  color: isActive ? (style?.text ?? "#3d3d8f") : "#444750",
                  border: isActive ? `1.5px solid ${style?.dot ?? "#5c6ac4"}` : "1.5px solid transparent",
                  transition: "all 0.1s",
                }}
              >
                {key && style && <span style={{ width: 6, height: 6, borderRadius: "50%", background: style.dot }} />}
                {label}
                {count > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: isActive ? (style?.dot ?? "#5c6ac4") : "#e1e3e5", color: isActive ? "#fff" : "#444750", minWidth: 18, textAlign: "center" }}>
                    {count}
                  </span>
                )}
              </a>
            );
          })}
        </div>

        {/* Search row — plain Form (GET) so it never shares state with the POST fetcher */}
        <Form method="get" style={{ display: "contents" }}>
          <input type="hidden" name="status" value={status} />
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <s-text-field
                label="Search"
                name="query"
                defaultValue={query}
                placeholder="CN number, order name, consignee…"
              />
            </div>
            <s-button type="submit">Search</s-button>
            {(status || query) && <s-button href="/app/shipments">Clear</s-button>}
            <s-button href={exportHref}>Export CSV</s-button>
          </div>
        </Form>
      </s-section>

      {/* ── Sync tools ── */}
      <s-section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <s-button
              variant="primary"
              disabled={isRefreshAll}
              loading={isRefreshAll}
              onClick={() => fetcher.submit({ intent: "refreshAll" }, { method: "post", action: "/app/shipments" })}
            >
              Sync all statuses
            </s-button>
          </div>
          <button
            onClick={() => setShowSyncPanel((v) => !v)}
            style={{ background: "none", border: "1px solid #c9cccf", borderRadius: 6, padding: "6px 12px", fontSize: 13, cursor: "pointer", color: "#444750", fontWeight: 500 }}
          >
            {showSyncPanel ? "▲ Hide date sync" : "▼ Sync by date range"}
          </button>
        </div>

        {showSyncPanel && (
          <div style={{ marginTop: 12, padding: "14px 16px", background: "#f6f6f7", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 10, fontWeight: 500 }}>
              Fetch latest status for all shipments booked within a date range
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <s-text-field
                  label="From"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target?.value ?? e.currentTarget?.value ?? fromDate)}
                />
              </div>
              <div>
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
                Sync date range
              </s-button>
            </div>
          </div>
        )}
      </s-section>

      {/* ── Batch action bar ── */}
      {selectedCns.size > 0 && (
        <s-section>
          <div style={{ background: "#f0f0ff", border: "1px solid #5c6ac4", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#3d3d8f" }}>{selectedCns.size} selected</div>
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

      {/* ── Batch cancel confirmation ── */}
      {batchCancelConfirm && (
        <s-section>
          <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 8, padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#7f0007", marginBottom: 6 }}>
              Cancel {selectedCns.size} shipment{selectedCns.size !== 1 ? "s" : ""}?
            </div>
            <div style={{ fontSize: 13, color: "#b40007", marginBottom: 12 }}>
              This will cancel them with Leopards Courier and cannot be undone.
              CNs: <span style={{ fontFamily: "monospace" }}>{Array.from(selectedCns).join(", ")}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <s-button
                tone="critical"
                disabled={isBatchCancel}
                loading={isBatchCancel}
                onClick={() => {
                  setBatchCancelConfirm(false);
                  fetcher.submit(
                    { intent: "cancelBatch", cnNumbers: Array.from(selectedCns).join(",") },
                    { method: "post", action: "/app/shipments" },
                  );
                }}
              >
                Yes, cancel all
              </s-button>
              <s-button onClick={() => setBatchCancelConfirm(false)} disabled={isBatchCancel}>
                Go back
              </s-button>
            </div>
          </div>
        </s-section>
      )}

      {/* ── Single cancel confirmation ── */}
      {cancelTarget && (
        <s-section>
          <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 8, padding: "16px 20px" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#7f0007", marginBottom: 6 }}>
              Cancel shipment <span style={{ fontFamily: "monospace" }}>{cancelTarget}</span>?
            </div>
            <div style={{ fontSize: 13, color: "#b40007", marginBottom: 12 }}>
              This will cancel it with Leopards Courier and cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <s-button
                tone="critical"
                disabled={submittingCn === cancelTarget}
                loading={submittingCn === cancelTarget}
                onClick={() => {
                  fetcher.submit({ intent: "cancel", cnNumbers: cancelTarget }, { method: "post", action: "/app/shipments" });
                }}
              >
                Yes, cancel
              </s-button>
              <s-button onClick={() => setCancelTarget(null)} disabled={submittingCn === cancelTarget}>
                Go back
              </s-button>
            </div>
          </div>
        </s-section>
      )}

      {/* ── Table ── */}
      <s-section>
        {loading ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "#6d7175", fontSize: 13 }}>
            Loading shipments…
          </div>
        ) : shipments.length === 0 ? (
          <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "48px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#202223", marginBottom: 4 }}>
              {status || query ? "No shipments match this filter" : "No shipments yet"}
            </div>
            <div style={{ fontSize: 13, color: "#6d7175" }}>
              {status && `Filtered by status: ${STATUS_STYLES[status]?.label ?? status}.`}
              {query && ` Searching for: "${query}".`}
              {!status && !query && "Booked orders will appear here."}
            </div>
            {(status || query) && (
              <a href="/app/shipments" style={{ display: "inline-block", marginTop: 12, padding: "7px 16px", background: "#5c6ac4", color: "#fff", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                Clear filters
              </a>
            )}
          </div>
        ) : (
          <>
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

                  const relevantDate =
                    shipment.deliveredAt ?? shipment.cancelledAt ?? shipment.bookedAt;

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
                            <span style={{ fontFamily: "monospace", fontSize: 13 }}>{shipment.cnNumber}</span>
                          </s-link>
                        ) : (
                          <span style={{ fontFamily: "monospace", fontSize: 13, color: shipment.cnNumber ? "#202223" : "#8c9196" }}>
                            {shipment.cnNumber || "—"}
                          </span>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <StatusPill status={shipment.status} />
                          {shipment.leopardStatusRaw &&
                            shipment.leopardStatusRaw.toLowerCase() !== (STATUS_STYLES[shipment.status]?.label ?? "").toLowerCase() && (
                            <span style={{ fontSize: 11, color: "#8c9196" }}>{shipment.leopardStatusRaw}</span>
                          )}
                          {shipment.lastError && (
                            <span style={{ fontSize: 11, color: "#d72c0d", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={shipment.lastError}>
                              {shipment.lastError}
                            </span>
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
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#202223" }}>{shipment.codAmount.toLocaleString()}</span>
                        ) : (
                          <span style={{ fontSize: 12, color: "#8c9196" }}>—</span>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        {relevantDate ? (
                          <div>
                            <div style={{ fontSize: 13, color: "#202223" }}>{new Date(relevantDate).toLocaleDateString()}</div>
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
            <span style={{ fontSize: 13, color: "#6d7175" }}>
              {startCount}–{endCount} of {total}
            </span>
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
