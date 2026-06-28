import { useEffect, useRef, useState } from "react";
import {
  Form, Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { listShipments, cancelShipments } from "../services/shipment.server";
import { getSettings } from "../services/settings.server";
import { LeopardApiClient } from "../integrations/leopards/client.server";
import { batchResolveCityNames } from "../services/city.server";
import db from "../db.server";

// ── Loader / Action ───────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url   = new URL(request.url);
  const query  = url.searchParams.get("query") ?? "";
  const page   = Number(url.searchParams.get("page") ?? "1");
  const limit  = 50;

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [{ shipments, total, pageCount }, recentLoadsheets] = await Promise.all([
    listShipments(store.id, "BOOKED", query, page, limit),
    db.loadsheet.findMany({
      where: { storeId: store.id, createdAt: { gte: cutoff24h } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const cityIdList = [];
  for (const s of shipments) {
    if (s.originCityId)      cityIdList.push(s.originCityId);
    if (s.destinationCityId) cityIdList.push(s.destinationCityId);
  }
  const cityNameMap = await batchResolveCityNames(store.id, cityIdList);
  const cityNames   = Object.fromEntries([...cityNameMap.entries()].map(([id, name]) => [id, name ?? String(id)]));

  return {
    query, page, pageCount, total, perPage: limit, cityNames,
    recentLoadsheets: recentLoadsheets.map((ls) => ({
      id:          ls.id,
      loadSheetId: ls.loadSheetId,
      cnCount:     ls.cnCount,
      status:      ls.status,
      createdAt:   ls.createdAt.toISOString(),
    })),
    shipments: shipments.map((s) => ({
      ...s,
      createdAt:   s.createdAt.toISOString(),
      updatedAt:   s.updatedAt.toISOString(),
      bookedAt:    s.bookedAt?.toISOString()    ?? null,
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

  if (intent === "generateLoadsheet") {
    const cnNumbers = String(formData.get("cnNumbers") ?? "")
      .split(",").map((v) => v.trim()).filter(Boolean);

    if (!cnNumbers.length) {
      return { ok: false, message: "No shipments selected.", intent };
    }

    const settings = await getSettings(store.id, { decrypt: true });
    const client   = new LeopardApiClient({ storeId: store.id, settings });
    const result   = await client.generateLoadSheet(cnNumbers);

    if (!result.ok) {
      return { ok: false, message: result.message ?? "Failed to generate load sheet.", intent };
    }

    const loadSheetId = result.raw?.load_sheet_id ?? result.data?.load_sheet_id;
    if (!loadSheetId) {
      return { ok: false, message: "Leopards did not return a load sheet ID.", intent };
    }

    const matched = await db.shipment.findMany({
      where: { storeId: store.id, cnNumber: { in: cnNumbers } },
      select: { id: true },
    });

    await db.loadsheet.create({
      data: {
        storeId:     store.id,
        loadSheetId: String(loadSheetId),
        cnCount:     cnNumbers.length,
        status:      "generated",
        shipments: {
          create: matched.map((s) => ({ shipmentId: s.id })),
        },
      },
    });

    return { ok: true, message: `Load sheet generated (ID: ${loadSheetId}).`, intent };
  }

  if (intent === "downloadLoadsheet") {
    const loadsheetDbId = String(formData.get("loadsheetDbId") ?? "");
    if (!loadsheetDbId) {
      return { ok: false, message: "Missing load sheet ID.", intent };
    }

    const loadsheet = await db.loadsheet.findFirst({
      where: { id: loadsheetDbId, storeId: store.id },
    });

    if (!loadsheet) {
      return { ok: false, message: "Load sheet not found.", intent };
    }

    const settings = await getSettings(store.id, { decrypt: true });
    const client   = new LeopardApiClient({ storeId: store.id, settings });
    const result   = await client.downloadLoadSheet(loadsheet.loadSheetId);

    if (!result.ok) {
      return { ok: false, message: result.message ?? "Failed to download load sheet.", intent };
    }

    await db.loadsheet.update({
      where: { id: loadsheetDbId },
      data:  { status: "downloaded" },
    }).catch(() => {});

    return {
      ok:        true,
      pdfBase64: result.data.toString("base64"),
      filename:  `loadsheet-${loadsheet.loadSheetId}.pdf`,
      intent,
    };
  }

  if (intent === "cancel" || intent === "cancelBatch") {
    const cnNumbers = String(formData.get("cnNumbers") ?? "")
      .split(",").map((v) => v.trim()).filter(Boolean);
    return { ...await cancelShipments(store.id, cnNumbers, admin), intent };
  }

  return { ok: false, message: "Unknown action.", intent };
};

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPageQuery({ query, page }) {
  const p = new URLSearchParams();
  if (query)    p.set("query", query);
  if (page > 1) p.set("page", String(page));
  return p.toString();
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Shipments() {
  const {
    shipments, query, page, pageCount, total, perPage,
    cityNames, recentLoadsheets,
  } = useLoaderData();

  const fetcher    = useFetcher();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify    = useAppBridge();

  const [selectedCns,        setSelectedCns]        = useState(() => new Set());
  const [cancelTarget,       setCancelTarget]        = useState(null);
  const [batchCancelConfirm, setBatchCancelConfirm] = useState(false);
  const prevFetcherData = useRef(null);

  const loading          = navigation.state === "loading";
  const isGenerating     = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generateLoadsheet";
  const isDownloading    = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "downloadLoadsheet";
  const isSingleCancel   = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "cancel";
  const isBatchCancel    = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "cancelBatch";
  const downloadingId    = isDownloading ? String(fetcher.formData?.get("loadsheetDbId") ?? "") : null;
  const submittingCn     = (isSingleCancel || isBatchCancel) ? fetcher.formData?.get("cnNumbers") : null;

  useEffect(() => {
    if (!fetcher.data || fetcher.data === prevFetcherData.current) return;
    prevFetcherData.current = fetcher.data;

    if (fetcher.data.intent === "generateLoadsheet") {
      if (fetcher.data.message) {
        shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
      }
      if (fetcher.data.ok) {
        setSelectedCns(new Set());
        revalidator.revalidate();
      }
    }

    if (fetcher.data.intent === "downloadLoadsheet") {
      if (fetcher.data.ok && fetcher.data.pdfBase64) {
        try {
          const binary = atob(fetcher.data.pdfBase64);
          const bytes  = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: "application/pdf" });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement("a");
          a.href     = url;
          a.download = fetcher.data.filename ?? "loadsheet.pdf";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
          revalidator.revalidate();
        } catch {
          shopify.toast.show("Failed to open PDF. Please try again.", { isError: true });
        }
      } else if (fetcher.data.message) {
        shopify.toast.show(fetcher.data.message, { isError: true });
      }
    }

    if (fetcher.data.intent === "cancel" || fetcher.data.intent === "cancelBatch") {
      if (fetcher.data.message) {
        shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
      }
      if (fetcher.data.ok) {
        revalidator.revalidate();
        if (fetcher.data.intent === "cancelBatch") { setSelectedCns(new Set()); setBatchCancelConfirm(false); }
        if (fetcher.data.intent === "cancel")      setCancelTarget(null);
      }
    }
  }, [fetcher.data, shopify]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleCn(cn) {
    setSelectedCns((prev) => {
      const n = new Set(prev);
      n.has(cn) ? n.delete(cn) : n.add(cn);
      return n;
    });
  }

  const bookableShipments = shipments.filter((s) => s.cnNumber);
  const allSelected       = bookableShipments.length > 0 && bookableShipments.every((s) => selectedCns.has(s.cnNumber));

  const startCount = total === 0 ? 0 : (page - 1) * perPage + 1;
  const endCount   = Math.min(page * perPage, total);

  return (
    <s-page heading="Shipments">

      {/* ── Cancel Modals ── */}
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

      {/* ── Load Sheet History (last 24 h) ── */}
      {recentLoadsheets.length > 0 && (
        <s-section>
          <div className="lb-card">
            <div className="lb-card-header">
              <span className="lb-section-label">Load Sheet History (last 24 hours)</span>
            </div>
            <div className="lb-card-body">
              <s-table>
                <s-table-header-row>
                  <s-table-header>Load Sheet ID</s-table-header>
                  <s-table-header>Shipments</s-table-header>
                  <s-table-header>Generated At</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Download</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {recentLoadsheets.map((ls) => {
                    const isThisDownloading = downloadingId === ls.id;
                    return (
                      <s-table-row key={ls.id}>
                        <s-table-cell>
                          <span className="lb-mono" style={{ fontSize: 13 }}>{ls.loadSheetId}</span>
                        </s-table-cell>
                        <s-table-cell>
                          <span style={{ fontSize: 13 }}>{ls.cnCount} CN{ls.cnCount !== 1 ? "s" : ""}</span>
                        </s-table-cell>
                        <s-table-cell>
                          <span style={{ fontSize: 13 }}>{new Date(ls.createdAt).toLocaleString()}</span>
                        </s-table-cell>
                        <s-table-cell>
                          <span style={{
                            fontSize:   12,
                            fontWeight: 600,
                            color:      ls.status === "downloaded" ? "#3d8b40" : "#2c6ecb",
                          }}>
                            {ls.status === "downloaded" ? "Downloaded" : "Generated"}
                          </span>
                        </s-table-cell>
                        <s-table-cell>
                          <s-button
                            disabled={isThisDownloading || (isDownloading && !isThisDownloading)}
                            loading={isThisDownloading}
                            onClick={() => fetcher.submit(
                              { intent: "downloadLoadsheet", loadsheetDbId: ls.id },
                              { method: "post", action: "/app/shipments" },
                            )}
                          >
                            Download PDF
                          </s-button>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            </div>
          </div>
        </s-section>
      )}

      {/* ── Batch action bar ── */}
      {selectedCns.size > 0 && (
        <s-section>
          <div style={{
            background:   "#eaf4fb",
            border:       "1px solid #90c5f0",
            borderRadius: 8,
            padding:      "12px 16px",
            display:      "flex",
            alignItems:   "center",
            gap:          12,
            flexWrap:     "wrap",
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#0d3880", flex: 1 }}>
              {selectedCns.size} shipment{selectedCns.size !== 1 ? "s" : ""} selected
            </div>
            <s-button
              variant="primary"
              disabled={isGenerating || isBatchCancel}
              loading={isGenerating}
              onClick={() => fetcher.submit(
                { intent: "generateLoadsheet", cnNumbers: Array.from(selectedCns).join(",") },
                { method: "post", action: "/app/shipments" },
              )}
            >
              Generate Load Sheet
            </s-button>
            <s-button
              tone="critical"
              disabled={isBatchCancel || isGenerating}
              loading={isBatchCancel}
              onClick={() => setBatchCancelConfirm(true)}
            >
              Cancel {selectedCns.size} shipment{selectedCns.size !== 1 ? "s" : ""}
            </s-button>
            <s-button onClick={() => setSelectedCns(new Set())} disabled={isGenerating || isBatchCancel}>
              Clear selection
            </s-button>
          </div>
        </s-section>
      )}

      {/* ── Search ── */}
      <s-section>
        <Form method="get" style={{ display: "contents" }}>
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
            {query && <s-button href="/app/shipments">Clear</s-button>}
          </div>
        </Form>
      </s-section>

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
              {query ? "No booked shipments match this search" : "No booked shipments yet"}
            </div>
            <div className="lb-empty-desc">
              {query ? `Searching: "${query}".` : "Booked orders will appear here."}
            </div>
            {query && (
              <Link to="/app/shipments" className="lb-btn lb-btn-primary" style={{ display: "inline-flex", marginTop: 16 }}>
                Clear search
              </Link>
            )}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#8c9196", marginBottom: 8, paddingLeft: 2 }}>
              Showing {startCount}–{endCount} of {total} booked shipment{total !== 1 ? "s" : ""}
            </div>
            <s-table>
              <s-table-header-row>
                <s-table-header>
                  <s-checkbox
                    checked={allSelected}
                    onChange={() => allSelected
                      ? setSelectedCns(new Set())
                      : setSelectedCns(new Set(bookableShipments.map((s) => s.cnNumber)))
                    }
                    disabled={bookableShipments.length === 0}
                  />
                </s-table-header>
                <s-table-header>Order</s-table-header>
                <s-table-header>CN Number</s-table-header>
                <s-table-header>Consignee</s-table-header>
                <s-table-header>Destination</s-table-header>
                <s-table-header>COD</s-table-header>
                <s-table-header>Booked At</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {shipments.map((shipment) => (
                  <s-table-row key={shipment.id}>
                    <s-table-cell>
                      <s-checkbox
                        checked={selectedCns.has(shipment.cnNumber)}
                        disabled={!shipment.cnNumber}
                        onChange={() => toggleCn(shipment.cnNumber)}
                      />
                    </s-table-cell>

                    <s-table-cell>
                      <s-link href={`/app/shipments/${shipment.id}`}>
                        <span style={{ fontWeight: 600 }}>{shipment.shopifyOrderName}</span>
                      </s-link>
                    </s-table-cell>

                    <s-table-cell>
                      <span
                        className="lb-mono"
                        style={{ fontSize: 13, color: shipment.cnNumber ? "#202223" : "#8c9196" }}
                      >
                        {shipment.cnNumber || "—"}
                      </span>
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
                      {shipment.bookedAt ? (
                        <div>
                          <div style={{ fontSize: 13, color: "#202223" }}>
                            {new Date(shipment.bookedAt).toLocaleDateString()}
                          </div>
                          <div style={{ fontSize: 11, color: "#8c9196" }}>
                            {new Date(shipment.bookedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </div>
                      ) : "—"}
                    </s-table-cell>

                    <s-table-cell>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <s-button href={`/app/shipments/${shipment.id}`}>View</s-button>
                        {shipment.slipLink && (
                          <s-button href={shipment.slipLink} target="_blank">Label</s-button>
                        )}
                        {shipment.cnNumber && (
                          <s-button
                            tone="critical"
                            disabled={submittingCn === shipment.cnNumber}
                            loading={submittingCn === shipment.cnNumber}
                            onClick={() => setCancelTarget(shipment.cnNumber)}
                          >
                            Cancel
                          </s-button>
                        )}
                      </div>
                    </s-table-cell>
                  </s-table-row>
                ))}
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
              href={page > 1 ? `/app/shipments?${buildPageQuery({ query, page: page - 1 })}` : undefined}
              disabled={page <= 1}
            >
              ← Previous
            </s-button>
            <span style={{ fontSize: 13, color: "#6d7175" }}>{startCount}–{endCount} of {total}</span>
            <s-button
              href={page < pageCount ? `/app/shipments?${buildPageQuery({ query, page: page + 1 })}` : undefined}
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
