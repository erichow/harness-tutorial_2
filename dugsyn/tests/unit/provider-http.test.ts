import { describe, expect, it } from "vitest";

import { hasProxyConfiguration } from "../../src/providers/http.js";

describe("provider HTTP transport", () => {
  it("detects lowercase and uppercase proxy configuration", () => {
    expect(hasProxyConfiguration({ HTTPS_PROXY: "http://proxy.example" })).toBe(true);
    expect(hasProxyConfiguration({ http_proxy: "http://proxy.example" })).toBe(true);
  });

  it("does not enable the proxy transport for NO_PROXY alone or empty values", () => {
    expect(hasProxyConfiguration({ NO_PROXY: "localhost" })).toBe(false);
    expect(hasProxyConfiguration({ HTTP_PROXY: "", HTTPS_PROXY: "" })).toBe(false);
  });
});
