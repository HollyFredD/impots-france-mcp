import { describe, expect, it } from "vitest";
import { BearerVerifier, unauthorizedResponse } from "../src/auth.js";
import { ConfigError, readConfig } from "../src/config.js";
import { hostAllowed, originAllowed, applySecurityHeaders } from "../src/hardening.js";
import { FixedWindowLimiter, tooManyRequestsResponse } from "../src/ratelimit.js";

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-0123456789";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2-9876543210";
const HOST = "mcp.example.com";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MCP_AUTH_TOKENS: TOKEN_A,
    ALLOWED_HOSTNAMES: HOST,
    ...overrides,
  };
}

describe("validation de configuration", () => {
  it("accepte une configuration minimale saine", () => {
    const config = readConfig(env({ MCP_AUTH_TOKENS: `${TOKEN_A},${TOKEN_B}` }));
    expect(config.authTokens).toEqual([TOKEN_A, TOKEN_B]);
    expect(config.allowedHostnames).toEqual([HOST]);
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimit.ipPerMinute).toBeGreaterThan(0);
  });

  it("refuse l'absence de jeton", () => {
    expect(() => readConfig({ ALLOWED_HOSTNAMES: HOST })).toThrow(ConfigError);
  });

  it("refuse un jeton trop court", () => {
    expect(() => readConfig(env({ MCP_AUTH_TOKENS: "court" }))).toThrow(/au moins 32/);
  });

  it("refuse un jeton d'exemple", () => {
    expect(() => readConfig(env({ MCP_AUTH_TOKENS: "changeme".padEnd(40, "x") }))).toThrow(
      /manque d'entropie|exemple/,
    );
  });

  it("refuse un jeton à faible entropie", () => {
    expect(() => readConfig(env({ MCP_AUTH_TOKENS: "a".repeat(64) }))).toThrow(/entropie/);
  });

  it("refuse un jeton dupliqué", () => {
    expect(() => readConfig(env({ MCP_AUTH_TOKENS: `${TOKEN_A},${TOKEN_A}` }))).toThrow(/double/);
  });

  it("refuse un hostname joker", () => {
    expect(() => readConfig(env({ ALLOWED_HOSTNAMES: "*" }))).toThrow(/joker/);
  });

  it("refuse une origine en clair hors boucle locale", () => {
    expect(() => readConfig(env({ ALLOWED_ORIGINS: "http://claude.ai" }))).toThrow(/https/);
  });

  it("refuse un corps de requête démesuré", () => {
    expect(() => readConfig(env({ MAX_BODY_BYTES: "99999999" }))).toThrow(/compris entre/);
    expect(() => readConfig(env({ MAX_BODY_BYTES: "1024" }))).not.toThrow();
  });
});

describe("vérificateur bearer", () => {
  const verifier = new BearerVerifier([TOKEN_A, TOKEN_B]);

  const withHeader = (value: string): Request =>
    new Request("https://example.test/mcp", { headers: { authorization: value } });

  it("accepte chaque jeton déclaré et les distingue", () => {
    const first = verifier.verify(withHeader(`Bearer ${TOKEN_A}`));
    const second = verifier.verify(withHeader(`Bearer ${TOKEN_B}`));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.subject).not.toBe(second.subject);
  });

  it("refuse un jeton proche", () => {
    expect(verifier.verify(withHeader(`Bearer ${TOKEN_A.slice(0, -1)}`)).ok).toBe(false);
  });

  it("refuse un schéma différent", () => {
    expect(verifier.verify(withHeader(`Basic ${TOKEN_A}`)).ok).toBe(false);
    expect(verifier.verify(withHeader(TOKEN_A)).ok).toBe(false);
  });

  it("ne divulgue rien dans la réponse 401", async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="impots-france-mcp"');
    expect(await response.text()).toBe('{"error":"unauthorized"}');
  });
});

describe("limiteur de débit", () => {
  it("bloque au-delà de la limite et indique un délai", () => {
    const limiter = new FixedWindowLimiter(2, 60_000);
    expect(limiter.consume("client").allowed).toBe(true);
    expect(limiter.consume("client").allowed).toBe(true);
    const blocked = limiter.consume("client");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isole les clés", () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("purge les fenêtres expirées", () => {
    const limiter = new FixedWindowLimiter(1, 1_000, 4);
    expect(limiter.consume("a", 0).allowed).toBe(true);
    for (let index = 0; index < 10; index += 1) limiter.consume(`k${index}`, 5_000);
    expect(tooManyRequestsResponse(3).headers.get("retry-after")).toBe("3");
  });
});

describe("garde-fous HTTP", () => {
  it("compare le Host sans le port", () => {
    const request = new Request("http://127.0.0.1:8080/mcp", { headers: { host: "mcp.example.com:443" } });
    expect(hostAllowed(request, ["mcp.example.com"])).toBe(true);
    expect(hostAllowed(request, ["autre.example.com"])).toBe(false);
  });

  it("refuse un Host absent", () => {
    const request = new Request("http://127.0.0.1:8080/mcp");
    expect(hostAllowed(request, ["mcp.example.com"])).toBe(false);
  });

  it("laisse passer l'absence d'Origin mais pas une Origin inconnue", () => {
    const anonymous = new Request("https://mcp.example.com/mcp");
    expect(originAllowed(anonymous, [])).toBe(true);
    const evil = new Request("https://mcp.example.com/mcp", {
      headers: { origin: "https://evil.example" },
    });
    expect(originAllowed(evil, [])).toBe(false);
    expect(originAllowed(evil, ["https://evil.example"])).toBe(true);
  });

  it("force no-store même si la réponse amont dit autre chose", () => {
    const upstream = new Response("ok", { headers: { "cache-control": "public, max-age=600", server: "x" } });
    const secured = applySecurityHeaders(upstream);
    expect(secured.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(secured.headers.get("server")).toBeNull();
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
