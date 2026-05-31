import { authenticate } from "../shopify.server";

// Required endpoint for all Shopify apps.
// Shopify sends this when a customer requests their stored data under GDPR.
// Acknowledge with 200. If you hold PII beyond Shipment records, email it to
// payload.customer.email within 30 days per Shopify's privacy requirements.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
