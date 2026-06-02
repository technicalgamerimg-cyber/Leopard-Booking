# Leopard Booking - Project Structure

## Directory Layout

```
leopard-booking/
├── app/                          # Main application code
│   ├── integrations/
│   │   └── leopards/
│   │       ├── client.server.js       # Leopard Courier API HTTP client
│   │       └── status-map.server.js   # Maps Leopard status codes to app statuses
│   ├── lib/
│   │   ├── crypto.server.js           # Encryption/decryption for API credentials
│   │   └── validation.server.js       # Booking payload validation, phone normalization
│   ├── routes/
│   │   ├── app.jsx                    # Authenticated app shell layout
│   │   ├── app._index.jsx             # Dashboard (metrics, charts)
│   │   ├── app.orders.jsx             # Orders list with booking actions
│   │   ├── app.shipments.jsx          # Shipments list with status/filters
│   │   ├── app.shipments.$id.jsx      # Single shipment detail view
│   │   ├── app.shipments.export.jsx   # Shipments CSV/export
│   │   ├── app.loadsheets.jsx         # Loadsheets list
│   │   ├── app.loadsheets.download.jsx # Loadsheet download
│   │   ├── app.settings.jsx           # Store settings configuration
│   │   ├── api.sync-statuses.jsx      # Internal API: cron/sync shipment statuses
│   │   ├── auth.$.jsx                 # Auth catch-all (Shopify OAuth)
│   │   ├── auth.login/                # Login page directory route
│   │   ├── _index/                    # Root index directory route
│   │   ├── healthz.jsx                # Health check endpoint
│   │   ├── webhooks.orders.create.jsx
│   │   ├── webhooks.orders.paid.jsx
│   │   ├── webhooks.orders.updated.jsx
│   │   ├── webhooks.orders.fulfilled.jsx
│   │   ├── webhooks.orders.cancelled.jsx
│   │   ├── webhooks.orders.delete.jsx
│   │   ├── webhooks.fulfillments.create.jsx
│   │   ├── webhooks.fulfillments.update.jsx
│   │   ├── webhooks.app.uninstalled.jsx
│   │   ├── webhooks.app.scopes_update.jsx
│   │   ├── webhooks.customers.data_request.jsx
│   │   ├── webhooks.customers.redact.jsx
│   │   └── webhooks.shop.redact.jsx
│   ├── services/                 # Business logic layer (server-only)
│   │   ├── booking.server.js     # Core booking logic: bookOrder, bookOrdersBatch
│   │   ├── city.server.js        # City lookup/cache resolution
│   │   ├── dashboard.server.js   # Dashboard metrics aggregation
│   │   ├── loadsheet.server.js   # Loadsheet generation
│   │   ├── settings.server.js    # Settings CRUD with credential encryption
│   │   ├── shipment.server.js    # Shipment queries, status sync
│   │   ├── shopify-orders.server.js # Shopify GraphQL order fetching
│   │   └── store.server.js       # Store install/uninstall management
│   ├── styles/
│   │   └── globals.css
│   ├── db.server.js              # Prisma client singleton
│   ├── entry.server.jsx          # React Router server entry point
│   ├── root.jsx                  # App root layout with AppProvider
│   ├── routes.js                 # Route config: flatRoutes()
│   └── shopify.server.js         # Shopify app instance, auth exports
├── api/
│   └── server.js                 # Express/Node server entry for production
├── prisma/
│   ├── schema.prisma             # Database schema (PostgreSQL)
│   └── migrations/               # Prisma migration history
├── extensions/                   # Shopify app extensions (empty)
├── public/                       # Static assets
├── scripts/
│   └── enable-writeback.mjs      # One-off script for enabling fulfillment writeback
├── shopify.app.toml              # Shopify app config: webhooks, scopes, URLs
├── shopify.web.toml              # Shopify web config
├── vite.config.js                # Vite build config with React Router plugin
├── .graphqlrc.js                 # GraphQL schema config for IDE hints
├── Dockerfile                    # Docker deployment
└── vercel.json                   # Vercel deployment config
```

## Core Architectural Patterns

### Layered Architecture
1. **Routes** (`app/routes/`) — React Router loaders/actions handle HTTP, authenticate, delegate to services
2. **Services** (`app/services/`) — Pure business logic, all server-only (`.server.js`)
3. **Integrations** (`app/integrations/`) — External API clients (Leopard Courier)
4. **Database** (`db.server.js` + Prisma) — Single Prisma client singleton

### Route Naming Conventions
- `app.*` — Authenticated Shopify admin routes (require `authenticate.admin`)
- `webhooks.*` — Shopify webhook handlers (require `authenticate.webhook`)
- `api.*` — Internal API endpoints
- `auth.*` — Authentication flow routes
- `*.server.js` — Server-only modules (never bundled to client)

### Data Models (Prisma)
- `Store` — One per installed shop; parent of all shop data
- `Settings` — One-to-one with Store; holds encrypted Leopard API credentials
- `Shipment` — One per Shopify order; tracks CN number and status lifecycle
- `ShipmentLog` — Audit trail of shipment events
- `Loadsheet` + `LoadsheetShipment` — Courier pickup manifests (many-to-many with Shipment)
- `WebhookLog` — Webhook receipt audit log
- `ApiLog` — Leopard API call audit log
- `CityCache` — Cached Leopard city list per store
- `Session` — Shopify OAuth session (managed by `@shopify/shopify-app-session-storage-prisma`)

### Key Relationships
- Every authenticated route extracts `storeId` from the session shop domain
- `booking.server.js` orchestrates: Settings → Shopify Order → City Resolution → Leopard API → DB upsert → Fulfillment writeback
- Webhooks are app-specific, declared in `shopify.app.toml`
