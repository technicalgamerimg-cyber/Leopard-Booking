import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import {
  clearCredentials,
  getSettings,
  saveSettings,
  testConnection,
} from "../services/settings.server";
import {
  getCityCacheStats,
  listOriginCities,
  refreshCities,
} from "../services/city.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const [settings, originCities, cityStats] = await Promise.all([
    getSettings(store.id),
    listOriginCities(store.id),
    getCityCacheStats(store.id),
  ]);

  return {
    settings: {
      ...settings,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
    },
    originCities: originCities.map((c) => ({ id: c.leopardCityId, name: c.name })),
    cityStats,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "test")          return testConnection(store.id);
  if (intent === "clear")         return clearCredentials(store.id);
  if (intent === "refreshCities") return refreshCities(store.id);
  return saveSettings(store.id, formData);
};

// ── Toggle component ──────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label, description }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          background: checked ? "#5c6ac4" : "#c4cdd5",
          cursor: "pointer",
          flexShrink: 0,
          position: "relative",
          transition: "background 0.2s",
          marginTop: 2,
        }}
      >
        <div style={{
          position: "absolute",
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 0.2s",
        }} />
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#202223", lineHeight: 1.3 }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: "#6d7175", marginTop: 3 }}>{description}</div>}
      </div>
    </div>
  );
}

// ── Section card wrapper ───────────────────────────────────────────────────────
function SettingsCard({ title, subtitle, children, danger }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${danger ? "#d72c0d" : "#e1e3e5"}`,
      borderRadius: 8,
      overflow: "hidden",
      marginBottom: 16,
    }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${danger ? "#fce8e7" : "#f1f2f4"}`, background: danger ? "#fce8e7" : "#f9fafb" }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: danger ? "#7f0007" : "#202223" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: danger ? "#b40007" : "#6d7175", marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ padding: "20px" }}>
        {children}
      </div>
    </div>
  );
}

function StatusDot({ ok, label }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 12, background: ok ? "#e3f1df" : "#f6f6f7", fontSize: 12, fontWeight: 600, color: ok ? "#1e542a" : "#6d7175" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: ok ? "#3d8b40" : "#c4cdd5" }} />
      {label}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Settings() {
  const { settings, originCities, cityStats } = useLoaderData();
  const credFetcher    = useFetcher();
  const defaultsFetcher = useFetcher();
  const cityFetcher    = useFetcher();
  const shopify = useAppBridge();

  const [clearConfirm, setClearConfirm] = useState(false);
  const [writeback, setWriteback]       = useState(Boolean(settings.fulfillmentWritebackEnabled));
  const [savedSection, setSavedSection] = useState(null);

  const credBusy     = credFetcher.state !== "idle";
  const defaultsBusy = defaultsFetcher.state !== "idle";
  const cityBusy     = cityFetcher.state !== "idle";

  useEffect(() => { setWriteback(Boolean(settings.fulfillmentWritebackEnabled)); }, [settings.fulfillmentWritebackEnabled]);

  useEffect(() => {
    if (credFetcher.data?.message) shopify.toast.show(credFetcher.data.message, { isError: !credFetcher.data.ok });
    if (credFetcher.data?.ok) { setSavedSection("cred"); setTimeout(() => setSavedSection(null), 3000); }
  }, [credFetcher.data, shopify]);

  useEffect(() => {
    if (defaultsFetcher.data?.message) shopify.toast.show(defaultsFetcher.data.message, { isError: !defaultsFetcher.data.ok });
    if (defaultsFetcher.data?.ok) { setSavedSection("defaults"); setTimeout(() => setSavedSection(null), 3000); }
  }, [defaultsFetcher.data, shopify]);

  useEffect(() => {
    if (cityFetcher.data?.message) shopify.toast.show(cityFetcher.data.message, { isError: !cityFetcher.data.ok });
  }, [cityFetcher.data, shopify]);

  const step1Done = settings.hasCredentials;
  const step2Done = cityStats.count > 0;
  const step3Done = Boolean(settings.originCityId) && Boolean(settings.shipperName);
  const allStepsDone = step1Done && step2Done && step3Done;

  return (
    <s-page heading="Settings">

      {/* ── Setup progress ── */}
      {!allStepsDone && (
        <s-section heading="Setup checklist">
          <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: 8, padding: "16px 20px" }}>
            {[
              { done: step1Done, label: "Save your Leopards API credentials", anchor: "#credentials" },
              { done: step2Done, label: "Refresh the city list (required for city matching)", anchor: "#cities" },
              { done: step3Done, label: "Set your origin city and shipper details", anchor: "#defaults" },
            ].map((step, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < 2 ? "1px solid #f1f2f4" : "none" }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{step.done ? "✅" : "⬜"}</span>
                <span style={{ fontSize: 14, color: step.done ? "#8c9196" : "#202223", textDecoration: step.done ? "line-through" : "none", flex: 1 }}>
                  {step.label}
                </span>
                {!step.done && (
                  <a href={step.anchor} style={{ fontSize: 12, color: "#5c6ac4", fontWeight: 600, textDecoration: "none" }}>Fix →</a>
                )}
              </div>
            ))}
          </div>
        </s-section>
      )}

      {/* ── Credentials ── */}
      <s-section heading="Leopards API credentials" id="credentials">
        <SettingsCard
          title="API connection"
          subtitle="Your Leopards Courier merchant API key and password. These are encrypted before storage."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <StatusDot ok={settings.hasCredentials} label={settings.hasCredentials ? "Credentials saved" : "Not configured"} />
            {settings.leopardEnvironment && (
              <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 10, background: settings.leopardEnvironment === "production" ? "#e3f1df" : "#eaf4fb", color: settings.leopardEnvironment === "production" ? "#1e542a" : "#084e8a", fontWeight: 600 }}>
                {settings.leopardEnvironment === "production" ? "Production" : "Staging"}
              </span>
            )}
          </div>

          <credFetcher.Form method="post">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <s-select
                label="Environment"
                name="environment"
                defaultValue={settings.leopardEnvironment}
                helpText="Use Staging to test without real bookings. Switch to Production when ready to go live."
              >
                <s-option value="staging">Staging (for testing)</s-option>
                <s-option value="production">Production (live bookings)</s-option>
              </s-select>

              <s-text-field
                label="API key"
                name="apiKey"
                placeholder={settings.leopardApiKeyMasked || "Enter your Leopards API key"}
                autoComplete="off"
                helpText="Found in your Leopards merchant dashboard under API settings."
              />
              <s-text-field
                label="API password"
                name="apiPassword"
                type="password"
                placeholder={settings.leopardApiPasswordMasked || "Enter your API password"}
                autoComplete="new-password"
              />

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <s-button type="submit" variant="primary" disabled={credBusy} loading={credBusy && !credFetcher.formData?.get("intent")}>
                  Save credentials
                </s-button>
                <credFetcher.Form method="post" style={{ display: "contents" }}>
                  <input type="hidden" name="intent" value="test" />
                  <s-button type="submit" disabled={credBusy || !settings.hasCredentials} loading={credBusy && credFetcher.formData?.get("intent") === "test"}>
                    Test connection
                  </s-button>
                </credFetcher.Form>
                {savedSection === "cred" && (
                  <span style={{ fontSize: 13, color: "#3d8b40", fontWeight: 600 }}>✓ Saved</span>
                )}
              </div>
            </div>
          </credFetcher.Form>
        </SettingsCard>
      </s-section>

      {/* ── City cache ── */}
      <s-section heading="City list" id="cities">
        <SettingsCard
          title="Leopards city master data"
          subtitle="The city list is used to match your customers' cities to Leopards destination codes. Refresh periodically or after onboarding."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <StatusDot ok={cityStats.count > 0} label={cityStats.count > 0 ? `${cityStats.count} cities cached` : "No cities cached"} />
            {cityStats.lastRefreshedAt && (
              <span style={{ fontSize: 12, color: "#6d7175" }}>
                Last refreshed {new Date(cityStats.lastRefreshedAt).toLocaleString()}
              </span>
            )}
          </div>
          {cityStats.count === 0 && (
            <div style={{ background: "#fff8ec", border: "1px solid #e8912d", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: "#8a4b00", marginBottom: 14 }}>
              ⚠️ Refresh the city list before booking — destination city matching requires this data.
            </div>
          )}
          <cityFetcher.Form method="post" style={{ display: "contents" }}>
            <input type="hidden" name="intent" value="refreshCities" />
            <s-button type="submit" disabled={cityBusy || !settings.hasCredentials} loading={cityBusy}>
              {cityStats.count > 0 ? "Refresh city list" : "Load cities"}
            </s-button>
          </cityFetcher.Form>
          {!settings.hasCredentials && (
            <div style={{ fontSize: 12, color: "#8c9196", marginTop: 8 }}>Save credentials above before refreshing cities.</div>
          )}
        </SettingsCard>
      </s-section>

      {/* ── Shipment defaults ── */}
      <s-section heading="Booking defaults" id="defaults">
        <SettingsCard
          title="Shipper &amp; booking defaults"
          subtitle="These values pre-fill every booking. Merchants can override weight, COD, and instructions per order."
        >
          <defaultsFetcher.Form method="post">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Origin city */}
              {originCities.length > 0 ? (
                <s-select
                  label="Origin city"
                  name="originCityId"
                  defaultValue={settings.originCityId ? String(settings.originCityId) : ""}
                  helpText="The city your packages are dispatched from."
                >
                  <s-option value="">— Select origin city —</s-option>
                  {originCities.map((city) => (
                    <s-option key={city.id} value={String(city.id)}>{city.name}</s-option>
                  ))}
                </s-select>
              ) : (
                <s-text-field
                  label="Origin city ID"
                  name="originCityId"
                  defaultValue={settings.originCityId || ""}
                  helpText="Refresh the city list above to pick from a dropdown instead."
                />
              )}

              {/* Shipper info */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
                <s-text-field label="Shipper name" name="shipperName" defaultValue={settings.shipperName || ""} helpText="Your business name as it appears on the waybill." />
                <s-text-field label="Shipper phone" name="shipperPhone" defaultValue={settings.shipperPhone || ""} />
                <s-text-field label="Shipper email" name="shipperEmail" defaultValue={settings.shipperEmail || ""} />
              </div>
              <s-text-field label="Shipper address" name="shipperAddress" defaultValue={settings.shipperAddress || ""} helpText="Your dispatch warehouse or office address." />

              {/* Package defaults */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <s-text-field
                  label="Default packet weight (grams)"
                  name="defaultWeightGrams"
                  defaultValue={settings.defaultWeightGrams}
                  helpText="Used when weight is not specified per order."
                />
                <s-text-field
                  label="Leopards service ID"
                  name="defaultShipmentId"
                  defaultValue={settings.defaultShipmentId || 1}
                  helpText="Your assigned Leopards shipment/service type. Most COD accounts use 1. Check your Leopards merchant portal if unsure."
                />
              </div>
              <s-text-field
                label="Default special instructions"
                name="defaultSpecialInstructions"
                defaultValue={settings.defaultSpecialInstructions || "Handle with care"}
                helpText="Printed on every waybill. Can be overridden per order."
              />
              <s-text-field
                label="COD gateway keywords"
                name="codGatewayKeywords"
                defaultValue={settings.codGatewayKeywords}
                helpText="Comma-separated Shopify payment gateway names treated as COD. E.g. 'cod, cash on delivery'. Orders with online gateways (Stripe, Visa, etc.) are automatically marked prepaid."
              />

              {/* Fulfillment writeback toggle */}
              <div style={{ paddingTop: 4 }}>
                <Toggle
                  checked={writeback}
                  onChange={setWriteback}
                  label="Auto-fulfill orders on booking"
                  description="When enabled, a fulfillment with the tracking number is automatically created in Shopify when you book a shipment. Highly recommended."
                />
                <input type="hidden" name="fulfillmentWritebackEnabled" value={writeback ? "on" : "off"} />
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 4 }}>
                <s-button type="submit" variant="primary" disabled={defaultsBusy} loading={defaultsBusy}>
                  Save defaults
                </s-button>
                {savedSection === "defaults" && (
                  <span style={{ fontSize: 13, color: "#3d8b40", fontWeight: 600 }}>✓ Saved</span>
                )}
              </div>
            </div>
          </defaultsFetcher.Form>
        </SettingsCard>
      </s-section>

      {/* ── Danger zone ── */}
      <s-section heading="Danger zone">
        <SettingsCard
          title="Clear API credentials"
          subtitle="Permanently removes your stored Leopards API key and password. All booking operations will stop immediately until new credentials are saved."
          danger
        >
          {!clearConfirm ? (
            <s-button
              tone="critical"
              disabled={credBusy || !settings.hasCredentials}
              onClick={() => setClearConfirm(true)}
            >
              Clear credentials
            </s-button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13, color: "#7f0007", fontWeight: 600 }}>
                Are you sure? This action cannot be undone. You will need to re-enter your API credentials to book shipments.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <credFetcher.Form method="post" style={{ display: "contents" }}>
                  <input type="hidden" name="intent" value="clear" />
                  <s-button
                    type="submit"
                    tone="critical"
                    disabled={credBusy}
                    loading={credBusy && credFetcher.formData?.get("intent") === "clear"}
                    onClick={() => setTimeout(() => setClearConfirm(false), 0)}
                  >
                    Yes, clear credentials
                  </s-button>
                </credFetcher.Form>
                <s-button onClick={() => setClearConfirm(false)} disabled={credBusy}>Cancel</s-button>
              </div>
            </div>
          )}
          {!settings.hasCredentials && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#8c9196" }}>No credentials are currently stored.</div>
          )}
        </SettingsCard>
      </s-section>

    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
