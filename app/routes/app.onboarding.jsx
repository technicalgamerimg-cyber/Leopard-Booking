import { useState } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useLoaderData,
  useActionData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureStore } from "../services/store.server";
import { getSettings, saveSettings, testConnection } from "../services/settings.server";
import { getCityCacheStats, listOriginCities, refreshCities } from "../services/city.server";

const TOTAL_STEPS = 6;

function isOnboardingComplete(settings, cityStats) {
  return Boolean(
    settings.hasCredentials &&
    settings.leopardEnvironment &&
    cityStats.count > 0 &&
    settings.originCityId &&
    settings.shipperName &&
    settings.shipperPhone &&
    settings.shipperAddress &&
    settings.defaultWeightGrams,
  );
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const url = new URL(request.url);
  const step = Math.max(1, Math.min(TOTAL_STEPS, Number(url.searchParams.get("step") ?? 1)));

  const t0 = performance.now();
  const settings = await getSettings(store.id);
  console.log("[onboarding] getSettings", Math.round(performance.now() - t0), "ms");

  const t1 = performance.now();
  const cityStats = await getCityCacheStats(store.id);
  console.log("[onboarding] getCityCacheStats", Math.round(performance.now() - t1), "ms");

  const t2 = performance.now();
  const originCities = step === 4 ? await listOriginCities(store.id) : [];
  if (step === 4) console.log("[onboarding] listOriginCities", Math.round(performance.now() - t2), "ms");

  // Only redirect on step 1 (welcome screen). Steps 2–6 should never be
  // interrupted mid-flow, even if the merchant has already completed setup.
  if (step === 1 && isOnboardingComplete(settings, cityStats)) {
    throw redirect("/app");
  }

  return {
    step,
    settings: {
      ...settings,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
    },
    cityStats,
    originCities: originCities.map((c) => ({ id: c.leopardCityId, name: c.name })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "test-connection") return testConnection(store.id);
  if (intent === "load-cities")     return refreshCities(store.id);

  if (intent === "save-credentials") {
    const result = await saveSettings(store.id, formData);
    if (!result.ok) return result;
    return redirect("/app/onboarding?step=3");
  }

  if (intent === "next-step") {
    const nextStep = parseInt(formData.get("nextStep") ?? "2", 10);
    return redirect(`/app/onboarding?step=${nextStep}`);
  }

  if (intent === "save-shipper") {
    const result = await saveSettings(store.id, formData);
    if (!result.ok) return result;
    return redirect("/app/onboarding?step=5");
  }

  if (intent === "save-preferences") {
    const result = await saveSettings(store.id, formData);
    if (!result.ok) return result;
    return redirect("/app/onboarding?step=6");
  }

  return { ok: false, message: "Unknown action." };
};

// ── Shared sub-components ─────────────────────────────────────────────────────

function WizardProgress({ step, total }) {
  const pct = Math.round((step / total) * 100);
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#6d7175" }}>
        <span style={{ fontWeight: 600, color: "#202223" }}>Step {step} of {total}</span>
        <span>{pct}% complete</span>
      </div>
      <div style={{ height: 6, background: "#e4e5e7", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#5c6ac4", borderRadius: 3, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function StepHeading({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, color: "#202223", margin: "0 0 4px" }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 13, color: "#6d7175", margin: 0, lineHeight: 1.5 }}>{subtitle}</p>}
    </div>
  );
}

function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: "#7f0007", marginBottom: 16 }}>
      {message}
    </div>
  );
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <button
        type="button"
        className="lb-toggle"
        style={{ background: checked ? "#5c6ac4" : "#c4cdd5", marginTop: 2, flexShrink: 0 }}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
      >
        <div className="lb-toggle-thumb" style={{ left: checked ? 22 : 2 }} />
      </button>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#202223", lineHeight: 1.3 }}>{label}</div>
        {description && (
          <div style={{ fontSize: 12, color: "#6d7175", marginTop: 3, lineHeight: 1.5 }}>{description}</div>
        )}
      </div>
    </div>
  );
}

// ── Step 1: Welcome ───────────────────────────────────────────────────────────

function StepWelcome() {
  return (
    <div style={{ textAlign: "center", paddingTop: 16 }}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>📦</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#202223", margin: "0 0 10px" }}>
        Welcome to Book With Leopards
      </h1>
      <p style={{ fontSize: 14, color: "#6d7175", margin: "0 auto 6px", lineHeight: 1.6, maxWidth: 480 }}>
        Your complete Shopify integration for Leopards Courier — book shipments, print waybills, and sync tracking automatically.
      </p>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6d7175", marginBottom: 28, background: "#f6f6f7", padding: "5px 14px", borderRadius: 20 }}>
        ⏱ About 2 minutes
      </div>

      <div style={{ textAlign: "left", background: "#f6f6f7", borderRadius: 8, padding: "16px 20px", marginBottom: 28, maxWidth: 420, marginLeft: "auto", marginRight: "auto" }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "#202223", marginBottom: 10 }}>What you'll set up:</div>
        {[
          "Connect your Leopards Courier merchant account",
          "Load the Leopards city list for destination matching",
          "Configure shipper details and booking defaults",
        ].map((item, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "#444750", marginBottom: 8 }}>
            <span style={{ color: "#5c6ac4", fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
            <span>{item}</span>
          </div>
        ))}
      </div>

      <Link
        to="/app/onboarding?step=2"
        style={{ display: "inline-block", padding: "10px 28px", background: "#5c6ac4", color: "#fff", borderRadius: 6, fontSize: 14, fontWeight: 700, textDecoration: "none" }}
      >
        Get Started →
      </Link>
    </div>
  );
}

// ── Step 2: Credentials ───────────────────────────────────────────────────────

function StepCredentials({ settings, actionData, testFetcher, testBusy, isSaving }) {
  return (
    <div>
      <StepHeading
        title="Leopards API Credentials"
        subtitle="Enter your merchant API key and password from your Leopards Courier account."
      />

      <div style={{ background: "#f0f7ff", border: "1px solid #b3d4f5", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#084e8a", marginBottom: 20, lineHeight: 1.5 }}>
        🔒 Your Leopards API credentials are used only to create shipments, retrieve city data, and synchronize shipment information. They are never shared with third parties.
      </div>

      <ErrorBanner message={actionData?.ok === false ? actionData.message : null} />

      <Form method="post">
        <input type="hidden" name="intent" value="save-credentials" />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <s-text-field
            label="API Key"
            name="apiKey"
            placeholder={settings.leopardApiKeyMasked || "Enter your Leopards API key"}
            autoComplete="off"
            helpText="Found in your Leopards merchant dashboard under API settings."
          />
          <s-text-field
            label="API Password"
            name="apiPassword"
            type="password"
            placeholder={settings.leopardApiPasswordMasked || "Enter your API password"}
            autoComplete="new-password"
          />

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingTop: 4 }}>
            <s-button type="submit" variant="primary" disabled={isSaving} loading={isSaving}>
              {isSaving ? "Saving..." : "Save & Continue"}
            </s-button>

            {settings.hasCredentials && (
              <testFetcher.Form method="post" style={{ display: "contents" }}>
                <input type="hidden" name="intent" value="test-connection" />
                <s-button type="submit" disabled={testBusy} loading={testBusy}>
                  {testBusy ? "Testing..." : "Test Connection"}
                </s-button>
              </testFetcher.Form>
            )}
          </div>

          {testFetcher.data && (
            <div style={{
              background: testFetcher.data.ok ? "#e3f1df" : "#fce8e7",
              border: `1px solid ${testFetcher.data.ok ? "#3d8b40" : "#d72c0d"}`,
              borderRadius: 6,
              padding: "10px 14px",
              fontSize: 13,
              color: testFetcher.data.ok ? "#1e542a" : "#7f0007",
            }}>
              {testFetcher.data.ok ? "✓ " : "✗ "}{testFetcher.data.message}
            </div>
          )}
        </div>
      </Form>
    </div>
  );
}

// ── Step 3: Load Cities ───────────────────────────────────────────────────────

function StepCities({ settings, cityStats, cityFetcher, cityBusy, citiesLoaded, cityCount, lastRefreshedAt }) {
  return (
    <div>
      <StepHeading
        title="Load City List"
        subtitle="We need to fetch the Leopards city master list to match your customers' cities to delivery codes."
      />

      {citiesLoaded ? (
        <div style={{ background: "#e3f1df", border: "1px solid #3d8b40", borderRadius: 6, padding: "12px 16px", marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#1e542a", marginBottom: 2 }}>
            ✓ {cityCount} cities available
          </div>
          <div style={{ fontSize: 12, color: "#3d8b40" }}>
            {cityFetcher.data?.ok
              ? "Just loaded successfully."
              : lastRefreshedAt
                ? `Last refreshed ${new Date(lastRefreshedAt).toLocaleString()}`
                : null}
          </div>
        </div>
      ) : (
        <div style={{ background: "#fff8ec", border: "1px solid #e8912d", borderRadius: 6, padding: "12px 16px", fontSize: 13, color: "#8a4b00", marginBottom: 20 }}>
          ⚠️ City list not yet loaded. This is required for booking — destination cities must be matched against Leopards city codes.
        </div>
      )}

      {cityFetcher.data && !cityFetcher.data.ok && (
        <div style={{ background: "#fce8e7", border: "1px solid #d72c0d", borderRadius: 6, padding: "10px 14px", fontSize: 13, color: "#7f0007", marginBottom: 16 }}>
          ✗ {cityFetcher.data.message}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <cityFetcher.Form method="post" style={{ display: "contents" }}>
          <input type="hidden" name="intent" value="load-cities" />
          <s-button
            type="submit"
            variant={citiesLoaded ? undefined : "primary"}
            disabled={cityBusy || !settings.hasCredentials}
            loading={cityBusy}
          >
            {cityBusy ? "Loading cities..." : citiesLoaded ? "Reload City List" : "Load City List"}
          </s-button>
        </cityFetcher.Form>

        <Link
          to="/app/onboarding?step=4"
          style={{
            display: "inline-block", padding: "10px 20px",
            background: citiesLoaded ? "#5c6ac4" : "#c4cdd5",
            color: "#fff", borderRadius: 6, fontSize: 14, fontWeight: 600, textDecoration: "none",
            pointerEvents: citiesLoaded ? "auto" : "none", opacity: citiesLoaded ? 1 : 0.6,
          }}
          onClick={(e) => { if (!citiesLoaded) e.preventDefault(); }}
        >
          Continue
        </Link>
      </div>

      {!settings.hasCredentials && (
        <div style={{ fontSize: 12, color: "#8c9196", marginTop: 8 }}>
          Save your API credentials first before loading cities.
        </div>
      )}
    </div>
  );
}

// ── Step 4: Shipper Details ───────────────────────────────────────────────────

function StepShipperDetails({ settings, originCities, actionData, isSaving }) {
  return (
    <div>
      <StepHeading
        title="Shipper Details"
        subtitle="These details appear on every waybill and are used as defaults for all bookings."
      />

      <ErrorBanner message={actionData?.ok === false ? actionData.message : null} />

      <Form method="post">
        <input type="hidden" name="intent" value="save-shipper" />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {originCities.length > 0 ? (
            <s-select
              label="Origin City"
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
              label="Origin City ID"
              name="originCityId"
              defaultValue={settings.originCityId || ""}
              helpText="Go back and load the city list to select from a dropdown."
            />
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <s-text-field
              label="Shipper Name"
              name="shipperName"
              defaultValue={settings.shipperName || ""}
              helpText="Your business name as it appears on the waybill."
            />
            <s-text-field
              label="Shipper Phone"
              name="shipperPhone"
              defaultValue={settings.shipperPhone || ""}
            />
            <s-text-field
              label="Shipper Email"
              name="shipperEmail"
              defaultValue={settings.shipperEmail || ""}
            />
          </div>

          <s-text-field
            label="Shipper Address"
            name="shipperAddress"
            defaultValue={settings.shipperAddress || ""}
            helpText="Your dispatch warehouse or office address."
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <s-text-field
              label="Default Packet Weight (grams)"
              name="defaultWeightGrams"
              defaultValue={settings.defaultWeightGrams ?? 1000}
              helpText="Used when weight is not specified per order."
            />
            <s-text-field
              label="Leopards Service ID"
              name="defaultShipmentId"
              defaultValue={settings.defaultShipmentId ?? 1}
              helpText="Your assigned Leopards service type. Most COD accounts use 1."
            />
          </div>

          <s-button type="submit" variant="primary" disabled={isSaving} loading={isSaving}>
            {isSaving ? "Saving..." : "Save & Continue"}
          </s-button>
        </div>
      </Form>
    </div>
  );
}

// ── Step 5: Booking Preferences ───────────────────────────────────────────────

function StepPreferences({ settings, writeback, setWriteback, actionData, isSaving }) {
  return (
    <div>
      <StepHeading
        title="Booking Preferences"
        subtitle="Configure how the app behaves when you book shipments."
      />

      <ErrorBanner message={actionData?.ok === false ? actionData.message : null} />

      <Form method="post">
        <input type="hidden" name="intent" value="save-preferences" />
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          <div style={{ background: "#fff", border: "1px solid #e4e5e7", borderRadius: 8, padding: 16 }}>
            <Toggle
              checked={writeback}
              onChange={setWriteback}
              label="Auto-fulfill orders on booking"
              description="When enabled, the app automatically creates a Shopify Fulfillment after a successful booking and attaches the Leopards tracking number. Customers can immediately view the tracking information from their order."
            />
            <input type="hidden" name="fulfillmentWritebackEnabled" value={writeback ? "on" : "off"} />
          </div>

          <s-text-field
            label="COD Gateway Keywords"
            name="codGatewayKeywords"
            defaultValue={settings.codGatewayKeywords ?? "cod,cash on delivery"}
            helpText="Comma-separated payment gateway names treated as Cash on Delivery. E.g. 'cod, cash on delivery'."
          />

          <s-text-field
            label="Default Special Instructions"
            name="defaultSpecialInstructions"
            defaultValue={settings.defaultSpecialInstructions || "Handle with care"}
            helpText="Printed on every waybill. Can be overridden per order."
          />

          <div style={{ background: "#f6f6f7", border: "1px solid #e4e5e7", borderRadius: 6, padding: "12px 14px", fontSize: 12, color: "#6d7175", lineHeight: 1.5 }}>
            ℹ️ Leopards Courier determines shipping charges and collects COD from the customer where applicable. This app only submits shipment information to Leopards and does not charge merchants.
          </div>

          <s-button type="submit" variant="primary" disabled={isSaving} loading={isSaving}>
            {isSaving ? "Saving..." : "Save & Continue"}
          </s-button>
        </div>
      </Form>
    </div>
  );
}

// ── Step 6: All Done ──────────────────────────────────────────────────────────

function StepAllDone() {
  return (
    <div style={{ textAlign: "center", paddingTop: 8 }}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>🎉</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: "#202223", margin: "0 0 8px" }}>
        Setup Complete!
      </h2>
      <p style={{ fontSize: 13, color: "#6d7175", margin: "0 0 28px", lineHeight: 1.5 }}>
        Your app is ready. Here's what happens when you book your first order:
      </p>

      <div style={{ textAlign: "left", background: "#f6f6f7", borderRadius: 8, padding: "16px 20px", marginBottom: 28, maxWidth: 500, marginLeft: "auto", marginRight: "auto" }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "#202223", marginBottom: 12 }}>What happens after booking:</div>
        {[
          { n: "1", text: "You book an order → Leopards receives the shipment and assigns a CN tracking number" },
          { n: "2", text: "The Shopify order is automatically updated with the CN tracking number (if auto-fulfill is enabled)" },
          { n: "3", text: "Your customer can immediately view tracking information from their order confirmation" },
        ].map((item) => (
          <div key={item.n} style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10, fontSize: 13, color: "#444750" }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#5c6ac4", color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
              {item.n}
            </span>
            <span style={{ lineHeight: 1.5 }}>{item.text}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 20 }}>
        <a
          href="/app/orders"
          style={{ display: "inline-block", padding: "12px 32px", background: "#5c6ac4", color: "#fff", borderRadius: 6, fontSize: 15, fontWeight: 700, textDecoration: "none" }}
        >
          Book Your First Order →
        </a>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 24, flexWrap: "wrap" }}>
        {[
          { href: "/app/shipments", label: "View Shipments" },
          { href: "/app/loadsheets", label: "Create Loadsheet" },
          { href: "/app", label: "Open Dashboard" },
        ].map((link) => (
          <a
            key={link.href}
            href={link.href}
            style={{ fontSize: 13, color: "#5c6ac4", fontWeight: 600, textDecoration: "none" }}
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Onboarding() {
  const { step, settings, cityStats, originCities } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const testFetcher = useFetcher();
  const cityFetcher = useFetcher();

  const [writeback, setWriteback] = useState(Boolean(settings.fulfillmentWritebackEnabled));

  const savingIntents = ["save-credentials", "save-shipper", "save-preferences"];
  const isSaving =
    navigation.state === "submitting" &&
    savingIntents.includes(navigation.formData?.get("intent"));

  const citiesLoaded = cityStats.count > 0 || cityFetcher.data?.ok === true;
  const cityCount = cityFetcher.data?.ok
    ? (cityFetcher.data.message?.match(/(\d+)/)?.[1] ?? cityStats.count)
    : cityStats.count;

  return (
    <s-page heading="Setup">
      <s-section>
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <WizardProgress step={step} total={TOTAL_STEPS} />

          {step === 1 && <StepWelcome />}

          {step === 2 && (
            <StepCredentials
              settings={settings}
              actionData={actionData}
              testFetcher={testFetcher}
              testBusy={testFetcher.state !== "idle"}
              isSaving={isSaving}
            />
          )}

          {step === 3 && (
            <StepCities
              settings={settings}
              cityStats={cityStats}
              cityFetcher={cityFetcher}
              cityBusy={cityFetcher.state !== "idle"}
              citiesLoaded={citiesLoaded}
              cityCount={cityCount}
              lastRefreshedAt={cityStats.lastRefreshedAt}
            />
          )}

          {step === 4 && (
            <StepShipperDetails
              settings={settings}
              originCities={originCities}
              actionData={actionData}
              isSaving={isSaving}
            />
          )}

          {step === 5 && (
            <StepPreferences
              settings={settings}
              writeback={writeback}
              setWriteback={setWriteback}
              actionData={actionData}
              isSaving={isSaving}
            />
          )}

          {step === 6 && <StepAllDone />}
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
