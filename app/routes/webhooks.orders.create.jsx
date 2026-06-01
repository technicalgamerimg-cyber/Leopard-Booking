import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getCodKeywords } from "../services/settings.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const store = await db.store.findUnique({
      where: { shopDomain: shop },
      include: { settings: true },
    });
    if (!store) return new Response();

    const order = payload;
    const shopifyOrderId = `gid://shopify/Order/${order.id}`;

    const codKeywords = getCodKeywords(store.settings);
    const gatewayText = (order.payment_gateway_names ?? []).join(" ").toLowerCase();
    // No gateway info → treat as COD (safer default for Pakistani stores).
    const isCod = !gatewayText || codKeywords.some((kw) => kw && gatewayText.includes(kw));
    const totalAmount = parseFloat(order.current_total_price ?? order.total_price ?? "0");
    const codAmount = isCod ? Math.round(totalAmount) : 0;

    const addr = order.shipping_address ?? order.billing_address;

    await db.shipment.upsert({
      where: {
        storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId },
      },
      create: {
        storeId: store.id,
        shopifyOrderId,
        shopifyOrderName: order.name,
        status: "PENDING",
        codAmount,
        weightGrams: store.settings?.defaultWeightGrams ?? 1000,
        consigneeName: addr?.name ?? "Unknown",
        consigneePhone: addr?.phone ?? order.phone ?? "",
        consigneeAddress: [
          addr?.address1,
          addr?.address2,
          addr?.city,
          addr?.province,
          addr?.zip,
        ]
          .filter(Boolean)
          .join(", "),
      },
      // Never overwrite a shipment that's already been booked or further along.
      update: {},
    });
  } catch (err) {
    console.error(`[${topic}] ${shop}:`, err);
  }

  return new Response();
};
