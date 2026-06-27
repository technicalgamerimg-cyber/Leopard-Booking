# Shopify Remix App — AI Guardrails

This project is a Shopify app built with:
- Remix (Shopify official structure)
- Polaris UI
- Prisma ORM
- React Router v7 (Shopify-managed)

────────────────────────────
🚨 NON-NEGOTIABLE RULES
────────────────────────────

## 1. Authentication
- ALWAYS use Shopify official auth:
  await authenticate.admin(request)

- NEVER:
  - create custom OAuth
  - modify session handling manually
  - bypass Shopify auth

────────────────────────────

## 2. React Router
- MUST use React Router v7 compatible with Shopify stack
- DO NOT downgrade to v6
- DO NOT mix router versions

If dependency conflict occurs:
→ fix versions, do not force downgrade

────────────────────────────

## 3. Prisma (Database)
- MUST use PostgreSQL only
- MUST reuse a single Prisma instance

Never create PrismaClient inside route handlers.

Correct pattern:
global singleton Prisma client

────────────────────────────

## 4. Performance Rules
- Always limit DB queries (take, skip, pagination)
- Avoid full table scans
- Avoid heavy computation inside loaders/actions

────────────────────────────

## 5. Project Structure Rules
Only use:

app/
  routes/
  db.server.js
  shopify.server.js
  utils/

DO NOT introduce unrelated frameworks or patterns.

────────────────────────────

## 6. Embedded Shopify App Rules
- Must support Shopify Admin embedded app flow
- Must preserve redirect/auth flow
- Must not break iframe session handling

────────────────────────────

## 7. Startup Order
Correct development flow:

1. npm install
2. npx prisma generate
3. shopify app dev

────────────────────────────

## 8. Dependency Safety Rules
If errors occur:
- First check version mismatches
- DO NOT randomly downgrade packages
- DO NOT reinstall unrelated dependencies
- Fix root cause only

##9. Make sure to never use sqlite as db or any purpose to store any data

##10. Don't use typescript

────────────────────────────

## GOAL
This app must remain:
- stable
- fast
- Shopify-compliant
- authentication-safe
- production-ready