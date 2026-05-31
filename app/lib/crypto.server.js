import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const configured = process.env.ENCRYPTION_KEY;

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      // Refusing to start without a real key in production prevents all stored
      // Leopard API credentials from being decryptable by anyone who reads the source.
      throw new Error(
        "ENCRYPTION_KEY environment variable is required in production. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    // Development-only fallback — never use in production.
    return crypto
      .createHash("sha256")
      .update("development-only-leopard-booking-key")
      .digest();
  }

  const decoded = Buffer.from(configured, "base64");
  if (decoded.length === 32) return decoded;

  return crypto.createHash("sha256").update(configured).digest();
}

export function encryptSecret(value) {
  if (!value) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv, tag, encrypted].map((part) => part.toString("base64")).join(":");
}

export function decryptSecret(value) {
  if (!value) return null;

  const parts = String(value).split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error(
      "Stored credential is corrupt or was encrypted with a different key. Re-enter your Leopards credentials in Settings.",
    );
  }

  const [ivText, tagText, encryptedText] = parts;

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getKey(),
      Buffer.from(ivText, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Stored credential is corrupt or was encrypted with a different key. Re-enter your Leopards credentials in Settings.",
    );
  }
}

export function maskSecret(value) {
  if (!value) return "";
  return "••••••••";
}
