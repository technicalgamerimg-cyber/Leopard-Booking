import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import {
  generateLoadsheet,
  listLoadsheets,
} from "../services/loadsheet.server";
import { listEligibleShipmentsForLoadsheet } from "../services/shipment.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const [loadsheets, eligible] = await Promise.all([
    listLoadsheets(store.id),
    listEligibleShipmentsForLoadsheet(store.id),
  ]);

  return {
    loadsheets: loadsheets.map((loadsheet) => ({
      id: loadsheet.id,
      loadSheetId: loadsheet.loadSheetId,
      status: loadsheet.status,
      cnCount: loadsheet.cnCount,
      createdAt: loadsheet.createdAt.toISOString(),
      shipments: loadsheet.shipments.map((entry) => ({
        cnNumber: entry.shipment?.cnNumber ?? "",
        orderName: entry.shipment?.shopifyOrderName ?? "",
      })),
    })),
    eligibleShipments: eligible.map((shipment) => ({
      id: shipment.id,
      cnNumber: shipment.cnNumber,
      orderName: shipment.shopifyOrderName,
      status: shipment.status,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();

  const cnNumbers = String(formData.get("cnNumbers") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const res = await generateLoadsheet(store.id, cnNumbers);
  return { success: res.ok, error: res.ok ? null : res.message, data: res };
};

export default function Loadsheets() {
  const { loadsheets, eligibleShipments } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const [selectedCns, setSelectedCns] = useState(
    () => new Set(eligibleShipments.map((s) => s.cnNumber)),
  );
  const [expandedLoadsheet, setExpandedLoadsheet] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  useEffect(() => {
    setSelectedCns(new Set(eligibleShipments.map((s) => s.cnNumber)));
  }, [eligibleShipments]);

  useEffect(() => {
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    } else if (fetcher.data?.success && fetcher.data.data?.message) {
      shopify.toast.show(fetcher.data.data.message);
    }
  }, [fetcher.data, shopify]);

  function toggleCn(cn) {
    setSelectedCns((prev) => {
      const next = new Set(prev);
      if (next.has(cn)) next.delete(cn);
      else next.add(cn);
      return next;
    });
  }

  function selectAll() {
    setSelectedCns(new Set(eligibleShipments.map((s) => s.cnNumber)));
  }

  function deselectAll() {
    setSelectedCns(new Set());
  }

  async function handleDownload(loadSheetId, rowId) {
    setDownloadingId(rowId);
    try {
      const url = `/app/loadsheets/download?loadSheetId=${encodeURIComponent(loadSheetId)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/pdf")) {
        const text = await response.text();
        throw new Error(text || "Unexpected response from server");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const win = window.open(objectUrl, "_blank");
      if (win) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      } else {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `loadsheet-${loadSheetId}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
      }
    } catch (err) {
      console.error("[loadsheet download]", err);
      shopify.toast.show("Could not download load sheet. Please try again.", { isError: true });
    } finally {
      setDownloadingId(null);
    }
  }

  const allSelected =
    eligibleShipments.length > 0 &&
    selectedCns.size === eligibleShipments.length;

  const selectedCnList = useMemo(
    () => Array.from(selectedCns).join(","),
    [selectedCns],
  );

  return (
    <s-page heading="Loadsheets">

      {/* ── Generate section ── */}
      <s-section heading="Generate loadsheet">
        {eligibleShipments.length === 0 ? (
          <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#202223", marginBottom: 4 }}>No eligible shipments</div>
            <div style={{ fontSize: 13, color: "#6d7175" }}>
              Loadsheets can only include booked, active shipments (not Cancelled, Delivered, or Returned).
              Book some orders first, then return here.
            </div>
            <a href="/app/orders" style={{ display: "inline-block", marginTop: 14, padding: "7px 16px", background: "#5c6ac4", color: "#fff", borderRadius: 6, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
              Go to Orders →
            </a>
          </div>
        ) : (
          <fetcher.Form method="post">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* Select all / count row */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <s-button onClick={allSelected ? deselectAll : selectAll} disabled={busy}>
                  {allSelected ? "Deselect all" : "Select all"}
                </s-button>
                <span style={{ fontSize: 13, color: "#6d7175" }}>
                  {selectedCns.size} of {eligibleShipments.length} shipment{eligibleShipments.length !== 1 ? "s" : ""} selected
                </span>
              </div>

              {/* Shipment checkboxes */}
              <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
                {eligibleShipments.map((shipment, i) => (
                  <div
                    key={shipment.id}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < eligibleShipments.length - 1 ? "1px solid #f1f2f4" : "none" }}
                  >
                    <s-checkbox
                      checked={selectedCns.has(shipment.cnNumber)}
                      onChange={() => toggleCn(shipment.cnNumber)}
                      disabled={busy}
                    />
                    <span style={{ fontWeight: 600, fontSize: 13, color: "#202223", fontFamily: "monospace" }}>{shipment.cnNumber}</span>
                    <span style={{ fontSize: 13, color: "#6d7175" }}>{shipment.orderName}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, padding: "2px 7px", borderRadius: 10, background: "#eaf4fb", color: "#084e8a", fontWeight: 600 }}>
                      {shipment.status}
                    </span>
                  </div>
                ))}
              </div>

              <input type="hidden" name="cnNumbers" value={selectedCnList} />
              <div>
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={busy || selectedCns.size === 0}
                  loading={busy}
                >
                  {busy
                    ? "Generating load sheet…"
                    : `Generate load sheet for ${selectedCns.size} shipment${selectedCns.size !== 1 ? "s" : ""}`}
                </s-button>
              </div>
            </div>
          </fetcher.Form>
        )}
      </s-section>

      {/* ── History section ── */}
      <s-section heading="History">
        {loadsheets.length === 0 ? (
          <div style={{ background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: 8, padding: "32px 20px", textAlign: "center" }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#202223", marginBottom: 4 }}>No load sheets yet</div>
            <div style={{ fontSize: 13, color: "#6d7175" }}>
              Select booked shipments above and click Generate to create your first load sheet.
            </div>
          </div>
        ) : (
          <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}>
            {loadsheets.map((loadsheet, i) => {
              const isExpanded = expandedLoadsheet === loadsheet.id;
              const isDownloading = downloadingId === loadsheet.id;
              return (
                <div key={loadsheet.id} style={{ borderBottom: i < loadsheets.length - 1 ? "1px solid #f1f2f4" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", flexWrap: "wrap" }}>
                    {/* ID + meta */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#202223", fontFamily: "monospace" }}>{loadsheet.loadSheetId}</div>
                      <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2 }}>
                        {loadsheet.cnCount} shipment{loadsheet.cnCount !== 1 ? "s" : ""} · {new Date(loadsheet.createdAt).toLocaleString()}
                      </div>
                    </div>

                    {/* Status badge */}
                    <span style={{ padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: loadsheet.status === "downloaded" ? "#e3f1df" : "#eaf4fb", color: loadsheet.status === "downloaded" ? "#1e542a" : "#084e8a", whiteSpace: "nowrap" }}>
                      {loadsheet.status === "downloaded" ? "Downloaded" : "Generated"}
                    </span>

                    {/* Download button */}
                    <s-button
                      onClick={() => handleDownload(loadsheet.loadSheetId, loadsheet.id)}
                      disabled={isDownloading}
                      loading={isDownloading}
                    >
                      {isDownloading ? "Downloading…" : "Download PDF"}
                    </s-button>

                    {/* Expand toggle */}
                    <button
                      onClick={() => setExpandedLoadsheet(isExpanded ? null : loadsheet.id)}
                      style={{ background: "none", border: "1px solid #c9cccf", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 12, color: "#444750", whiteSpace: "nowrap" }}
                    >
                      {isExpanded ? "▲ Hide" : "▼ Contents"}
                    </button>
                  </div>

                  {/* Expanded contents */}
                  {isExpanded && (
                    <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                      {loadsheet.shipments.map((s, idx) => (
                        <div key={`${s.cnNumber}-${idx}`} style={{ display: "flex", gap: 10, fontSize: 13, color: "#444750" }}>
                          <span style={{ fontFamily: "monospace", color: "#202223", fontWeight: 600 }}>{s.cnNumber}</span>
                          <span style={{ color: "#6d7175" }}>{s.orderName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
