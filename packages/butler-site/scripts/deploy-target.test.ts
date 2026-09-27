import { describe, expect, test } from "bun:test";
import { DEFAULT_SITE_DOMAIN, resolveDeployTarget } from "./deploy-target";

describe("resolveDeployTarget", () => {
  test("serves the site from the root of butler.hexpy.games by default", () => {
    expect(DEFAULT_SITE_DOMAIN).toBe("butler.hexpy.games");
    expect(resolveDeployTarget({})).toEqual({ domain: "butler.hexpy.games", site: "https://butler.hexpy.games", base: "/" });
  });

  test("SITE_DOMAIN switches the custom domain and the site URL together", () => {
    expect(resolveDeployTarget({ SITE_DOMAIN: " docs.example.com \n" }))
      .toEqual({ domain: "docs.example.com", site: "https://docs.example.com", base: "/" });
    expect(resolveDeployTarget({ SITE_DOMAIN: "" }).domain).toBe("butler.hexpy.games");
  });

  test("SITE_URL and SITE_BASE override the URL and base path (previews)", () => {
    expect(resolveDeployTarget({ SITE_URL: "http://localhost:4321/", SITE_BASE: "preview" }))
      .toEqual({ domain: "butler.hexpy.games", site: "http://localhost:4321", base: "/preview/" });
    expect(resolveDeployTarget({ SITE_BASE: "/" }).base).toBe("/");
  });

  test("rejects a domain that is not a bare host name", () => {
    expect(() => resolveDeployTarget({ SITE_DOMAIN: "https://butler.hexpy.games" })).toThrow("SITE_DOMAIN");
    expect(() => resolveDeployTarget({ SITE_DOMAIN: "butler.hexpy.games/help" })).toThrow("SITE_DOMAIN");
  });
});
