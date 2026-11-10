import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { silentLogger } from "../src/log.js";

const TOKEN = "s3cr3t-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEF";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8080,
    mcpPath: "/mcp",
    healthPath: "/healthz",
    authTokens: [TOKEN],
    allowedHostnames: ["example.test"],
    allowedOrigins: [],
    trustProxy: false,
    maxBodyBytes: 262_144,
    rateLimit: { ipPerMinute: 120, tokenPerMinute: 600 },
    logLevel: "error",
    ...overrides,
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1.0.0" },
  },
});

/** Le handler MCP peut répondre en JSON ou en SSE selon l'en-tête Accept. */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return JSON.parse(data[data.length - 1] ?? "{}");
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/mcp", {
    method: "POST",
    headers: {
      host: "example.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body,
  });
}

const client = { ip: "203.0.113.10", requestId: "test-request" };

describe("authentification bearer", () => {
  it("refuse une requête sans jeton", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const request = new Request("https://example.test/mcp", {
      method: "POST",
      headers: { host: "example.test", "content-type": "application/json" },
      body: INITIALIZE,
    });
    const response = await app.fetch(request, client);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });

  it("refuse un jeton invalide sans révéler la raison", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(post(INITIALIZE, { authorization: "Bearer wrong-token-value" }), client);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });

  it("accepte un jeton valide sur la poignée de main MCP", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(post(INITIALIZE), client);
    expect(response.status).toBe(200);
    const body = (await readPayload(response)) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("impots-france-mcp");
    await app.close();
  });
});

describe("surface HTTP", () => {
  it("protège aussi la sonde de santé", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const anonymous = await app.fetch(
      new Request("https://example.test/healthz", { headers: { host: "example.test" } }),
      client,
    );
    expect(anonymous.status).toBe(401);

    const authorized = await app.fetch(
      new Request("https://example.test/healthz", {
        headers: { host: "example.test", authorization: `Bearer ${TOKEN}` },
      }),
      client,
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ status: "ok", toolCount: 62 });
    await app.close();
  });

  it("répond 404 sur un chemin inconnu, sans indice", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(
      new Request("https://example.test/admin", {
        headers: { host: "example.test", authorization: `Bearer ${TOKEN}` },
      }),
      client,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    await app.close();
  });

  it("rejette un Host non autorisé", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(post(INITIALIZE, { host: "attacker.test" }), client);
    expect(response.status).toBe(421);
    await app.close();
  });

  it("rejette une Origin non autorisée", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(post(INITIALIZE, { origin: "https://evil.test" }), client);
    expect(response.status).toBe(403);
    await app.close();
  });

  it("rejette une méthode non prévue", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(
      new Request("https://example.test/mcp", {
        method: "PUT",
        headers: { host: "example.test", authorization: `Bearer ${TOKEN}` },
        body: "{}",
      }),
      client,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, GET, DELETE");
    await app.close();
  });

  it("rejette un corps qui n'est pas du JSON", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(
      post("outil=oui", { "content-type": "text/plain" }),
      client,
    );
    expect(response.status).toBe(415);
    await app.close();
  });

  it("ajoute les en-têtes de durcissement", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const response = await app.fetch(post(INITIALIZE), client);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-request-id")).toBe("test-request");
    expect(response.headers.get("server")).toBeNull();
    await app.close();
  });

  it("limite le débit par IP", async () => {
    const app = createApp(baseConfig({ rateLimit: { ipPerMinute: 2, tokenPerMinute: 600 } }), {
      logger: silentLogger,
    });
    const client = { ip: "198.51.100.7", requestId: "rate" };
    await app.fetch(post(INITIALIZE, { authorization: "Bearer bad" }), client);
    await app.fetch(post(INITIALIZE, { authorization: "Bearer bad" }), client);
    const blocked = await app.fetch(post(INITIALIZE, { authorization: "Bearer bad" }), client);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    await app.close();
  });
});

describe("outils exposés", () => {
  it("liste et appelle un outil à travers HTTP", async () => {
    const app = createApp(baseConfig(), { logger: silentLogger });
    const listed = await app.fetch(
      post(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        { "mcp-protocol-version": "2025-06-18" },
      ),
      client,
    );
    expect(listed.status).toBe(200);
    const list = (await readPayload(listed)) as { result?: { tools?: unknown[] } };
    expect(list.result?.tools).toHaveLength(62);

    const called = await app.fetch(
      post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "verifier_actualite_fiscale",
            arguments: { annee_cible: 2026 },
          },
        }),
        { "mcp-protocol-version": "2025-06-18" },
      ),
      client,
    );
    const payload = (await readPayload(called)) as {
      result?: { structuredContent?: { result?: Record<string, unknown> } };
    };
    expect(payload.result?.structuredContent?.result).toMatchObject({
      registryVersion: "2026.08.01",
      targetYear: 2026,
    });
    await app.close();
  });
});
