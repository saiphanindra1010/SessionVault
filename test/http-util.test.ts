import { beforeEach, describe, expect, it } from "vitest";
import { isOriginAllowed } from "../lib/web-auth.js";

beforeEach(() => {
  delete process.env.PUBLIC_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.NODE_ENV;
});

function req(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://sv.example.com/api/auth/login", {
    method,
    headers,
  });
}

describe("isOriginAllowed", () => {
  it("allows GET regardless of Origin", () => {
    expect(isOriginAllowed(req("GET"))).toBe(true);
  });

  it("with PUBLIC_URL set, only matching Origin is allowed on POST", () => {
    process.env.PUBLIC_URL = "https://sv.example.com";
    expect(
      isOriginAllowed(req("POST", { origin: "https://sv.example.com" }))
    ).toBe(true);
    expect(isOriginAllowed(req("POST", { origin: "https://evil.com" }))).toBe(
      false
    );
  });

  it("allows matching Referer when Origin is absent", () => {
    process.env.PUBLIC_URL = "https://sv.example.com";
    expect(
      isOriginAllowed(
        req("POST", { referer: "https://sv.example.com/dashboard" })
      )
    ).toBe(true);
  });

  it("fails closed in production without PUBLIC_URL", () => {
    process.env.NODE_ENV = "production";
    expect(isOriginAllowed(req("POST", { origin: "http://localhost:3000" }))).toBe(
      false
    );
  });
});
