# Leopard Booking - Technology Stack

## Languages & Runtimes
- **JavaScript (ESM)** — Primary language (`"type": "module"` in package.json)
- **JSX** — React components (`.jsx` files; mixed `.jsx`/`.js` codebase, no `.tsx` in routes)
- **TypeScript** — Type checking via `tsconfig.json`; used for type generation, not strict enforcement in all files
- **Node.js** — Required: `>=20.19 <22 || >=22.12`

## Framework & Core Libraries
| Library | Version | Purpose |
|---|---|---|
| `react-router` | ^7.12.0 | Full-stack framework (SSR, routing, loaders/actions) |
| `@react-router/dev` | ^7.12.0 | Vite plugin, build tooling |
| `@shopify/shopify-app-react-router` | ^1.1.0 | Shopify OAuth, webhook auth, session management |
| `@shopify/app-bridge-react` | ^4.2.4 | Embedded app UI bridge |
| `@shopify/shopify-app-session-storage-prisma` | ^9.0.0 | Prisma-backed session storage |
| `react` / `react-dom` | ^18.3.1 | UI rendering |
| `recharts` | ^3.8.1 | Dashboard charts |
| `lucide-react` | ^1.16.0 | Icons |
| `canvas-confetti` | ^1.9.4 | UI celebration effects |

## Database
- **Prisma ORM** ^6.16.3 with `@prisma/client` ^6.16.3
- **PostgreSQL** (production) — `datasource provider = "postgresql"`
- **SQLite** (local dev) — `prisma/dev.sqlite`
- `DATABASE_URL` env var controls the connection

## Build System
- **Vite** ^6.3.6 with `@react-router/dev/vite` plugin
- `vite-tsconfig-paths` ^5.1.4 — path alias support
- Output: `build/server/index.js` (server), `build/client/` (client assets)
- `assetsInlineLimit: 0` — no asset inlining

## Development Tools
| Tool | Purpose |
|---|---|
| ESLint ^8.57.1 | Linting (react, jsx-a11y, @typescript-eslint, import plugins) |
| Prettier ^3.6.2 | Code formatting |
| `@shopify/api-codegen-preset` | GraphQL type generation |
| Shopify CLI | Dev tunnel, app scaffolding, deploy |

## Key Environment Variables
```
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SHOPIFY_APP_URL
SCOPES / SHOPIFY_SCOPES
DATABASE_URL
SHOP_CUSTOM_DOMAIN       # optional
LEOPARD_ENCRYPTION_KEY   # for AES encryption of API credentials
PORT                     # default 3000
FRONTEND_PORT            # default 8002 (non-localhost HMR)
NODE_ENV
PRISMA_CLIENT_ENGINE_TYPE=binary  # Windows ARM64 workaround
```

## NPM Scripts
```bash
npm run dev           # shopify app dev (local dev with tunnel)
npm run build         # react-router build
npm run start         # react-router-serve ./build/server/index.js
npm run setup         # prisma generate && prisma migrate deploy
npm run docker-start  # npm run setup && npm run start
npm run deploy        # shopify app deploy
npm run lint          # eslint with cache
npm run typecheck     # react-router typegen && tsc --noEmit
npm run graphql-codegen # generate GraphQL types
```

## Deployment
- **Vercel** — primary (`vercel.json` present, app URL: `https://book-with-leopards.vercel.app`)
- **Docker** — `Dockerfile` + `.dockerignore` for containerized deploy
- **Shopify CLI** — `shopify app deploy` for extension/config sync
- Shopify API version: `October25` (`2025-10`)

## GraphQL
- Shopify Admin API GraphQL (via `@shopify/shopify-app-react-router` admin client)
- `.graphqlrc.js` — IDE schema hints pointing to Shopify Admin API
- Inline GraphQL tagged with `#graphql` comment for IDE support
- No separate GraphQL client library; uses `admin.graphql()` from Shopify auth
