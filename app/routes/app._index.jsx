import { boundary } from "@shopify/shopify-app-react-router/server";
import { Link, redirect, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { getSettings, isOnboardingComplete } from "../services/settings.server";
import { getCityCacheStats } from "../services/city.server";
import { getDashboard } from "../services/dashboard.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);

  const [settings, cityStats] = await Promise.all([
    getSettings(store.id),
    getCityCacheStats(store.id),
  ]);

  if (!isOnboardingComplete(settings, cityStats)) {
    const incomingUrl = new URL(request.url);
    const onboardingUrl = new URL("/app/onboarding", request.url);
    for (const [key, value] of incomingUrl.searchParams.entries()) {
      onboardingUrl.searchParams.set(key, value);
    }
    throw redirect(onboardingUrl.pathname + onboardingUrl.search);
  }

  return getDashboard(store.id);
};

const STATUS_STYLES = {
  PENDING:    { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00", label: "Not booked" },
  BOOKED:     { dot: "#2c6ecb", bg: "#eaf4fb", text: "#0d3880", label: "Booked" },
  IN_TRANSIT: { dot: "#5c6ac4", bg: "#f0f0ff", text: "#3d3d8f", label: "In transit" },
  DELIVERED:  { dot: "#3d8b40", bg: "#e3f1df", text: "#1e542a", label: "Delivered" },
  RETURNED:   { dot: "#e8912d", bg: "#fff5ea", text: "#8a4b00", label: "Returned" },
  CANCELLED:  { dot: "#8c9196", bg: "#f6f6f7", text: "#444750", label: "Cancelled" },
  EXCEPTION:  { dot: "#d72c0d", bg: "#fce8e7", text: "#7f0007", label: "Exception" },
};

const EVENT_LABELS = {
  BOOKED:        "Booked",
  CANCELLED:     "Cancelled",
  STATUS_CHANGE: "Status updated",
  ERROR:         "Error",
};

function eventDotColor(type) {
  if (type === "ERROR" || type === "CANCELLED") return "#d72c0d";
  if (type === "BOOKED") return "#3d8b40";
  return "#5c6ac4";
}

function eventBadgeStyle(type) {
  if (type === "ERROR")     return { bg: "#fce8e7", text: "#7f0007" };
  if (type === "CANCELLED") return { bg: "#fce8e7", text: "#7f0007" };
  if (type === "BOOKED")    return { bg: "#e3f1df", text: "#1e542a" };
  return { bg: "#f0f0ff", text: "#3d3d8f" };
}

function formatRelative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

function MetricCard({ label, value, color, sublabel, href }) {
  const inner = (
    <div className="lb-metric-card" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="lb-metric-label">{label}</div>
      <div className="lb-metric-value">{value ?? 0}</div>
      {sublabel && <div className="lb-metric-sublabel">{sublabel}</div>}
    </div>
  );
  return href
    ? <Link to={href} style={{ textDecoration: "none", display: "block" }}>{inner}</Link>
    : inner;
}

function QuickActionBtn({ href, children, primary }) {
  return (
    <Link to={href} className={`lb-quick-action${primary ? " lb-quick-action-primary" : ""}`}>
      {children}
    </Link>
  );
}

export default function Dashboard() {
  const { counts, bookedToday, cancelledToday, bookedAllTime, recentLogs } = useLoaderData();

  return (
    <s-page heading="Dashboard">

      {/* ── Overview KPIs ── */}
      <s-section heading="Overview">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <MetricCard label="Booked today"      value={bookedToday}       color="#2c6ecb" sublabel="new bookings today"  href="/app/shipments" />
          <MetricCard label="Cancelled today"   value={cancelledToday}    color="#d72c0d" sublabel="cancellations today" />
          <MetricCard label="Booked all time"   value={bookedAllTime}     color="#3d8b40" sublabel="total ever booked"   href="/app/shipments" />
          <MetricCard label="Cancelled all time" value={counts.CANCELLED} color="#8c9196" sublabel="total cancelled" />
        </div>
      </s-section>

      {/* ── Shipment health bar ── */}
      {counts.total > 0 && (
        <s-section heading="Shipment health">
          <div className="lb-card"><div className="lb-card-body">
            {/* Stacked bar */}
            <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 14, background: "#f1f2f4" }}>
              {[
                { key: "DELIVERED",  color: "#3d8b40" },
                { key: "IN_TRANSIT", color: "#5c6ac4" },
                { key: "BOOKED",     color: "#2c6ecb" },
                { key: "RETURNED",   color: "#e8912d" },
                { key: "EXCEPTION",  color: "#d72c0d" },
                { key: "CANCELLED",  color: "#c4cdd5" },
                { key: "PENDING",    color: "#e4e5e7" },
              ].map(({ key, color }) => {
                const pct = ((counts[key] ?? 0) / counts.total) * 100;
                return pct > 0
                  ? <div key={key} style={{ flex: `0 0 ${pct}%`, background: color }} />
                  : null;
              })}
            </div>
            {/* Legend */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
              {Object.entries(STATUS_STYLES).map(([key, s]) =>
                counts[key] > 0 ? (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
                    <span style={{ color: "#444750", fontWeight: 600 }}>{s.label}</span>
                    <span style={{ color: "#8c9196" }}>{counts[key]}</span>
                  </div>
                ) : null
              )}
            </div>
          </div></div>
        </s-section>
      )}

      {/* ── Quick actions ── */}
      <s-section heading="Quick actions">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <QuickActionBtn href="/app/orders" primary>Book orders</QuickActionBtn>
          <QuickActionBtn href="/app/shipments">View shipments</QuickActionBtn>
          <QuickActionBtn href="/app/settings">Settings</QuickActionBtn>
        </div>
      </s-section>

      {/* ── Recent activity feed ── */}
      <s-section heading="Recent activity">
        {recentLogs?.length ? (
          <div className="lb-card">
            {recentLogs.map((log) => {
              const badge = eventBadgeStyle(log.eventType);
              return (
                <div key={log.id} className="lb-list-row">
                  <span className="lb-timeline-dot" style={{ background: eventDotColor(log.eventType) }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: "#202223" }}>{log.orderName}</span>
                      {log.cnNumber && (
                        <span className="lb-mono" style={{ fontSize: 12, color: "#6d7175", background: "#f6f6f7", padding: "1px 5px", borderRadius: 4 }}>
                          {log.cnNumber}
                        </span>
                      )}
                      <span className="lb-pill" style={{ background: badge.bg, color: badge.text, borderColor: "transparent" }}>
                        {EVENT_LABELS[log.eventType] ?? log.eventType}
                      </span>
                    </div>
                    {log.message && (
                      <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {log.message}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#8c9196", flexShrink: 0, whiteSpace: "nowrap" }}>
                    {formatRelative(log.createdAt)}
                  </div>
                </div>
              );
            })}
            <div style={{ padding: "10px 16px", background: "var(--lb-surface-muted)", borderTop: "1px solid var(--lb-border)" }}>
              <Link to="/app/shipments" style={{ fontSize: 13, color: "var(--lb-primary)", fontWeight: 600, textDecoration: "none" }}>
                View booked shipments →
              </Link>
            </div>
          </div>
        ) : (
          <div className="lb-empty">
            <span className="lb-empty-icon">📦</span>
            <div className="lb-empty-title">No shipment activity yet</div>
            <div className="lb-empty-desc" style={{ marginBottom: 16 }}>
              Book your first order to see activity here.
            </div>
            <Link to="/app/orders" className="lb-btn lb-btn-primary">
              Book an order
            </Link>
          </div>
        )}
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
