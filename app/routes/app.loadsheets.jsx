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
  // Track which load sheet row is currently downloading
  const [downloadingId, setDownloadingId] = useState(null);

  // Re-sync selection if the loader returns a different eligible set.
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

  /**
   * Fetch the PDF blob from the server and open it in a new tab.
   * Falls back to a toast error if anything goes wrong — never navigates away.
   */
  async function handleDownload(loadSheetId, rowId) {
    setDownloadingId(rowId);
    try {
      const url = `/app/loadsheets/download?loadSheetId=${encodeURIComponent(loadSheetId)}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/pdf")) {
        const text = await response.text();
        throw new Error(text || "Unexpected response from server");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const win = window.open(objectUrl, "_blank");
      // Revoke after a short delay to free memory once the tab has loaded.
      if (win) {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      } else {
        // Popup was blocked — fall back to a direct link download.
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `loadsheet-${loadSheetId}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
      }
    } catch (err) {
      console.error("[loadsheet download]", err);
      shopify.toast.show(
        "Could not download load sheet. Please try again.",
        { isError: true },
      );
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
      <s-section heading="Generate loadsheet">
        {eligibleShipments.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text>No eligible shipments available.</s-text>
              <s-text tone="subdued" variant="bodySmall">
                Loadsheets can only include booked, non-terminal shipments (not
                Cancelled, Delivered, or Returned). Book some orders first, then
                return here to generate a load sheet.
              </s-text>
            </s-stack>
          </s-box>
        ) : (
          <fetcher.Form method="post">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" blockAlign="center">
                <s-button
                  onClick={allSelected ? deselectAll : selectAll}
                  disabled={busy}
                >
                  {allSelected ? "Deselect all" : "Select all"}
                </s-button>
                <s-text tone="subdued" variant="bodySmall">
                  {selectedCns.size} of {eligibleShipments.length} shipment
                  {eligibleShipments.length !== 1 ? "s" : ""} selected
                </s-text>
              </s-stack>

              <s-stack direction="block" gap="extraSmall">
                {eligibleShipments.map((shipment) => (
                  <s-checkbox
                    key={shipment.id}
                    label={`${shipment.orderName} — ${shipment.cnNumber}`}
                    checked={selectedCns.has(shipment.cnNumber)}
                    onChange={() => toggleCn(shipment.cnNumber)}
                  />
                ))}
              </s-stack>

              <input type="hidden" name="cnNumbers" value={selectedCnList} />
              <s-button
                type="submit"
                variant="primary"
                disabled={busy || selectedCns.size === 0}
                loading={busy}
              >
                {busy
                  ? `Generating load sheet…`
                  : `Generate load sheet for ${selectedCns.size} shipment${selectedCns.size !== 1 ? "s" : ""}`}
              </s-button>
            </s-stack>
          </fetcher.Form>
        )}
      </s-section>

      <s-section heading="History">
        {loadsheets.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text>No load sheets generated yet.</s-text>
              <s-text tone="subdued" variant="bodySmall">
                Select booked shipments above and click Generate to create your
                first load sheet.
              </s-text>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Loadsheet ID</s-table-header>
              <s-table-header>Shipments</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>PDF</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {loadsheets.map((loadsheet) => {
                const isExpanded = expandedLoadsheet === loadsheet.id;
                const isDownloading = downloadingId === loadsheet.id;
                return (
                  <s-table-row key={loadsheet.id}>
                    <s-table-cell>
                      <s-text variant="bodySmall" tone="subdued">
                        {loadsheet.loadSheetId}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>{loadsheet.cnCount}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={loadsheet.status === "downloaded" ? "success" : "info"}
                      >
                        {loadsheet.status === "downloaded" ? "Downloaded" : "Generated"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(loadsheet.createdAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        onClick={() =>
                          handleDownload(loadsheet.loadSheetId, loadsheet.id)
                        }
                        disabled={isDownloading}
                        loading={isDownloading}
                      >
                        {isDownloading ? "Generating PDF…" : "Download"}
                      </s-button>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="extraSmall">
                        <s-link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setExpandedLoadsheet(
                              isExpanded ? null : loadsheet.id,
                            );
                          }}
                        >
                          {isExpanded ? "Hide" : "Show"} contents
                        </s-link>
                        {isExpanded && (
                          <s-stack direction="block" gap="extraSmall">
                            {loadsheet.shipments.map((s, idx) => (
                              <s-text key={`${s.cnNumber}-${idx}`} variant="bodySmall">
                                {s.orderName} — {s.cnNumber}
                              </s-text>
                            ))}
                          </s-stack>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
