# Leopard Booking - Development Guidelines

## Code Quality Standards

### File Naming Conventions
- Server-only modules use `.server.js` suffix — enforced by React Router's bundler to exclude from client
- Route files use dot-separated naming: `app.orders.jsx`, `webhooks.orders.create.jsx`
- Services are colocated under `app/services/`, integrations under `app/integrations/`
- Directory routes (e.g. `auth.login/`, `_index/`) allowed for grouping related files

### Module Style
- ESM throughout (`"type": "module"` in package.json)
- Named exports for loaders, actions, ErrorBoundary; default export for the route component
- Service functions are individually named exports (no class wrappers in services layer)
- Prisma client is a singleton exported from `db.server.js`:
  ```js
  // dev: reuse global to avoid connection pool exhaustion on HMR
  if (process.env.NODE_ENV !== "production") {
    if (!global.prismaGlobal) global.prismaGlobal = new PrismaClient();
  }
  const prisma = global.prismaGlobal ?? new PrismaClient();
  export default prisma;
  ```

### Error Handling Pattern
- Every authenticated route exports `ErrorBoundary` using Shopify's boundary helper:
  ```js
  import { boundary } from "@shopify/shopify-app-react-router/server";
  export function ErrorBoundary() {
    return boundary.error(useRouteError());
  }
  ```
- Service functions return `{ ok: boolean, message: string, ...extras }` — never throw to the caller
- API client errors return structured objects: `{ ok, code, message, fieldErrors, raw, httpStatus, leopardStatus }`
- Console logging with bracketed module prefix: `[bookOrder]`, `[fulfillment writeback]`, `[LeopardApiClient]`

## Authentication & Authorization Patterns

### Every Authenticated Route
```js
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  // ... use store.id for all DB queries
};
```
- Always call `authenticate.admin(request)` first — this handles OAuth redirects automatically
- Always call `ensureStore(session)` to get/create the Store record — never use `session.shop` directly as a DB key
- `storeId` (cuid from DB) is the consistent tenant key, not the shop domain string

### Webhook Routes
```js
export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  // handle topic
  return new Response(null, { status: 200 });
};
```
- Webhooks always return HTTP 200 even on non-fatal errors (prevents Shopify retries for already-processed events)
- Topics are declared in `shopify.app.toml`, not registered programmatically

### Action Intent Pattern (multi-action routes)
```js
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const store = await ensureStore(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "test")          return testConnection(store.id);
  if (intent === "clear")         return clearCredentials(store.id);
  if (intent === "refreshCities") return refreshCities(store.id);
  return saveSettings(store.id, formData);  // default action
};
```
- Use a hidden `intent` field to dispatch multiple actions from one route
- Each intent maps to a dedicated service function

## Data Layer Patterns

### Prisma Upsert for Idempotency
Shipments always use `upsert` with composite unique keys to handle webhook redelivery:
```js
await db.shipment.upsert({
  where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: order.id } },
  create: { ... },
  update: { ... },
});
```

### Parallel DB + API calls
Use `Promise.all` for independent async operations:
```js
const [settings, originCities, cityStats] = await Promise.all([
  getSettings(store.id),
  listOriginCities(store.id),
  getCityCacheStats(store.id),
]);
```

### Batch operations over N+1 queries
In batch booking, fetch all existing shipments in one query, then filter:
```js
const existingShipments = await db.shipment.findMany({
  where: { storeId, shopifyOrderId: { in: orderIds }, status: { not: "CANCELLED" } },
  select: { shopifyOrderId: true, shopifyOrderName: true },
});
const bookedByOrderId = new Map(existingShipments.map((s) => [s.shopifyOrderId, s]));
```

### Date Serialization
Dates from DB must be serialized before returning from loaders (React Router can't serialize `Date` objects):
```js
return {
  settings: {
    ...settings,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  },
};
```

## UI Component Patterns

### Shopify Polaris Web Components
The app uses Polaris Web Components (`s-*` tags) — NOT React Polaris components:
```jsx
<s-page heading="Settings">
  <s-section heading="API credentials" id="credentials">
    <s-text-field label="API key" name="apiKey" />
    <s-button type="submit" variant="primary" loading={busy}>Save</s-button>
    <s-select label="Environment" name="environment" defaultValue="staging">
      <s-option value="staging">Staging</s-option>
      <s-option value="production">Production</s-option>
    </s-select>
  </s-section>
</s-page>
```

### Multiple Fetchers per Page
Use separate `useFetcher()` instances for independent form sections to avoid shared loading state:
```js
const credFetcher     = useFetcher();
const testFetcher     = useFetcher();
const defaultsFetcher = useFetcher();
const cityFetcher     = useFetcher();
```

### Toast Notifications via App Bridge
```js
const shopify = useAppBridge();
useEffect(() => {
  if (fetcher.data?.message) {
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }
}, [fetcher.data, shopify]);
```

### Inline Styles (not CSS classes)
All component styles use inline style objects — no CSS modules or class-based styling except `globals.css`:
```jsx
<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
```

### Small Reusable UI Components
Extract small presentational components inline within route files:
```jsx
function Toggle({ checked, onChange, label, description }) { ... }
function SettingsCard({ title, subtitle, children, danger }) { ... }
function StatusDot({ ok, label }) { ... }
```

## External API Integration Patterns (LeopardApiClient)

### Retry with Exponential Backoff
```js
for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
  // ... fetch call
  if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    continue;
  }
}
```
- MAX_RETRIES = 3, backoff: 1s, 2s, 4s
- Only retry on 5xx; abort on network errors after last attempt

### AbortController Timeouts
```js
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
try {
  const response = await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timeoutId); // always clear to avoid memory leaks
}
```

### Normalized API Response Shape
All Leopard API calls return a consistent shape regardless of success/failure:
```js
// success
{ ok: true, data: ..., raw: ..., httpStatus: 200, leopardStatus: 1 }
// failure
{ ok: false, code: "LEOPARDS_*_FAILED", message: "...", fieldErrors: ..., raw: ..., httpStatus: ..., leopardStatus: ... }
```

### All API calls are logged
Every request logs to the `ApiLog` table via `this.logCall(endpoint, result, latencyMs, retryCount)` — even failures.

### Form-encoded vs JSON body
- Default: `application/x-www-form-urlencoded` (Leopard's standard API)
- Exception: batch booking uses `{ json: true }` option for `application/json`
- Arrays are encoded as repeated `key[]` params for form-encoded requests

## GraphQL Patterns

### Inline GraphQL with `#graphql` tag
```js
const QUERY = `#graphql
  query FulfillmentOrdersForOrder($orderId: ID!) {
    order(id: $orderId) { ... }
  }
`;
const response = await admin.graphql(QUERY, { variables: { orderId } });
const json = await response.json();
```

### Always check `userErrors`
```js
const errors = json.data?.fulfillmentCreate?.userErrors ?? [];
if (errors.length) {
  console.error("[fulfillment writeback] errors:", JSON.stringify(errors));
}
```

### Use optional chaining for GraphQL response traversal
```js
const nodes = foJson.data?.order?.fulfillmentOrders?.nodes ?? [];
```

## Routing Conventions

### Flat Routes
`app/routes.js` uses `flatRoutes()` from `@react-router/fs-routes` — file names define the route hierarchy via dots.

### Navigation
- Use `Link` from `react-router` (not `<a>`) for in-app navigation
- Use `redirect` from `authenticate.admin` (not from `react-router`) for server redirects
- Use `useSubmit` from `react-router` for programmatic form submission

## Security Patterns
- Leopard API credentials are encrypted at rest (AES via `app/lib/crypto.server.js`) — never stored plaintext
- Settings queries use `{ decrypt: true }` option when credentials are needed for API calls
- HMAC validation for webhooks is handled by `authenticate.webhook` — logged in `WebhookLog`
- All DB queries are scoped by `storeId` — no cross-tenant data access
