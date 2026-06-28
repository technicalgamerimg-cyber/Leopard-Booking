import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Leopards Courier — Shopify Integration</h1>
        <p className={styles.text}>
          Book, track, and manage Leopards courier shipments directly from your
          Shopify Admin.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Install on your store
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>One-click booking</strong>. Send any Shopify order to
            Leopards Courier with a single click — no copying customer data
            between systems.
          </li>
          <li>
            <strong>Real-time tracking</strong>. Statuses sync automatically and
            on-demand, with delivered and cancelled events written back to
            Shopify fulfillments.
          </li>
        </ul>
      </div>
    </div>
  );
}
