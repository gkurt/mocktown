import { describe, expect, test } from "bun:test";
import { normalizeUrl, stripVolatile, templatePath } from "../src/capture/normalize.ts";

describe("path templating", () => {
  test("names the parameter after the collection it belongs to", () => {
    expect(templatePath("/v1/orders/8812")).toBe("/v1/orders/{orderId}");
    expect(templatePath("/repos/acme/widgets/issues/42")).toBe("/repos/acme/widgets/issues/{issueId}");
    expect(templatePath("/companies/17/policies/9")).toBe("/companies/{companyId}/policies/{policyId}");
  });

  test("recognises the id shapes real APIs use", () => {
    expect(templatePath("/v1/customers/cus_MR7dlLEfqZuUiAwY")).toBe("/v1/customers/{customerId}");
    expect(templatePath("/things/550e8400-e29b-41d4-a716-446655440000")).toBe("/things/{thingId}");
    expect(templatePath("/blobs/8f14e45fceea167a5a36dedd4bea2543")).toBe("/blobs/{blobId}");
    expect(templatePath("/v1/invoices/inv_000001")).toBe("/v1/invoices/{invoiceId}");
  });

  test("leaves route words alone", () => {
    // Over-templating is worse than under-templating: it merges endpoints that differ.
    expect(templatePath("/v1/customers")).toBe("/v1/customers");
    expect(templatePath("/api/v2/health/live")).toBe("/api/v2/health/live");
    expect(templatePath("/users/me/settings")).toBe("/users/me/settings");
    // Prefix-underscore-suffix like an id, but the suffix carries no digits: a route word.
    expect(templatePath("/webhooks/payment_intents")).toBe("/webhooks/payment_intents");
  });
});

describe("url normalization", () => {
  test("splits service, path and query", () => {
    const n = normalizeUrl("https://api.stripe.com:443/v1/charges/ch_3P1?limit=10&expand=customer");
    expect(n.service).toBe("api.stripe.com");
    expect(n.path).toBe("/v1/charges/ch_3P1");
    expect(n.query).toEqual({ limit: "10", expand: "customer" });
  });
});

describe("volatile headers", () => {
  test("are dropped so two recordings of one endpoint can be diffed", () => {
    const kept = stripVolatile({ "content-type": "application/json", date: "Mon, 31 Aug 2026 10:00:00 GMT", "cf-ray": "abc" }, "response");
    expect(kept).toEqual({ "content-type": "application/json" });
  });
});
