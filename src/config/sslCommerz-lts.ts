import SSLCommerzPayment from "sslcommerz-lts";

export function getSsl() {
  return new SSLCommerzPayment(
    process.env.SSL_STORE_ID!,
    process.env.SSL_STORE_PASSWORD!,
    process.env.SSL_IS_LIVE === "true",
  );
}

export function uniqueTranId(prefix = "EDU") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}