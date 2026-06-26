import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings } from "../services/settings.server";
import { getCityCacheStats } from "../services/city.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  if (url.pathname !== "/app/onboarding") {
    const store = await db.store.findUnique({
      where: { shopDomain: session.shop },
      select: { id: true },
    });

    if (store) {
      const [settings, cityStats] = await Promise.all([
        getSettings(store.id),
        getCityCacheStats(store.id),
      ]);

      const complete = Boolean(
        settings.hasCredentials &&
        settings.leopardEnvironment &&
        cityStats.count > 0 &&
        settings.originCityId &&
        settings.shipperName &&
        settings.shipperPhone &&
        settings.shipperAddress &&
        settings.defaultWeightGrams,
      );

      if (!complete) {
        throw redirect("/app/onboarding");
      }
    }
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

const NAV_ITEMS = [
  { href: "/app", label: "Dashboard", match: (p) => p === "/app" },
  { href: "/app/orders", label: "Orders", match: (p) => p.startsWith("/app/orders") },
  { href: "/app/shipments", label: "Shipments", match: (p) => p.startsWith("/app/shipments") },
  { href: "/app/loadsheets", label: "Loadsheets", match: (p) => p.startsWith("/app/loadsheets") },
  { href: "/app/settings", label: "Settings", match: (p) => p.startsWith("/app/settings") },
];

export default function App() {
  const { apiKey } = useLoaderData();
  const location = useLocation();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {NAV_ITEMS.map((item) => {
          const isActive = item.match(location.pathname);
          return (
            <s-link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
            >
              {item.label}
            </s-link>
          );
        })}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
