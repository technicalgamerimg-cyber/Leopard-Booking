# Leopard Booking - Product Overview

## Purpose
Leopard Booking is an embedded Shopify app that integrates Shopify stores with the Leopard Courier service (a Pakistani courier/logistics provider). It automates shipment booking, tracking, and fulfillment sync between Shopify orders and the Leopard Courier API.

## Value Proposition
- Eliminates manual order entry into Leopard Courier by automatically creating shipments from Shopify orders
- Provides real-time shipment status tracking synced back to Shopify fulfillments
- Generates loadsheets (courier pickup manifests) for batch courier handoffs
- Supports COD (Cash on Delivery) detection based on payment gateway keywords

## Key Features
- **Shipment Booking**: Book Shopify orders as Leopard Courier shipments with CN (consignment note) numbers
- **Status Sync**: Sync shipment statuses from Leopard back to Shopify (via `/api/sync-statuses`)
- **Fulfillment Writeback**: Optionally write tracking info back to Shopify fulfillments
- **Loadsheets**: Generate and download courier loadsheets (PDF/batch manifests)
- **Order Management**: Dashboard view of all orders and shipments with filtering
- **Settings**: Per-store configuration for Leopard API credentials, shipper info, COD gateway keywords, default weights
- **City Cache**: Cached lookup of Leopard Courier cities for origin/destination
- **Webhook Processing**: Handles Shopify order lifecycle events (create, paid, fulfilled, cancelled, deleted, updated) and fulfillment events
- **Privacy Compliance**: GDPR-compliant webhook handlers for customer data requests/deletion
- **Analytics Dashboard**: Dashboard with shipment metrics via recharts

## Target Users
- Shopify merchants in Pakistan using Leopard Courier as their shipping provider
- Store owners who need automated courier booking without manual data entry

## Use Cases
1. Merchant installs app → configures Leopard API credentials and shipper details
2. New Shopify order arrives → webhook triggers automatic shipment creation in Leopard
3. Courier picks up packages → loadsheet generated and downloaded
4. Shipment delivered → status synced back to Shopify fulfillment
5. COD orders → detected by payment gateway keywords and COD amount set accordingly

## Deployment
- Hosted at: `https://book-with-leopards.vercel.app`
- Embedded Shopify app (runs inside Shopify Admin iframe)
- PostgreSQL database (production), SQLite (local dev)
