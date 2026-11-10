/**
 * Configuration du serveur, lue depuis l'environnement et validée au démarrage.
 *
 * Principe : échec immédiat et explicite si une valeur manque ou est faible.
 * Aucun secret n'est affiché dans les messages d'erreur.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export type RateLimitConfig = {
  /** Requêtes autorisées par adresse IP et par minute. */
  readonly ipPerMinute: number;
  /** Requêtes autorisées par jeton et par minute. */
  readonly tokenPerMinute: number;
};

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly healthPath: string;
  readonly authTokens: readonly string[];
  readonly allowedHostnames: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: boolean;
  readonly maxBodyBytes: number;
  readonly rateLimit: RateLimitConfig;
  readonly logLevel: LogLevel;
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const MINIMUM_TOKEN_LENGTH = 32;
const MINIMUM_TOKEN_ALPHABET = 12;
const PLACEHOLDER_TOKENS = new Set([
  "changeme",
  "change-me",
  "secret",
  "token",
  "password",
  "test",
  "example",
]);

function fail(message: string): never {
  throw new ConfigError(message);
}

function readRaw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readList(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = readRaw(env, key);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = readRaw(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) fail(`${key} doit être un entier positif.`);
  const value = Number.parseInt(raw, 10);
  if (value < minimum || value > maximum) {
    fail(`${key} doit être compris entre ${minimum} et ${maximum}.`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readRaw(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fail(`${key} doit valoir true ou false.`);
}

function validateToken(token: string, index: number): string {
  const position = index + 1;
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    fail(
      `MCP_AUTH_TOKENS : le jeton ${position} doit contenir au moins ${MINIMUM_TOKEN_LENGTH} caractères.`,
    );
  }
  if (PLACEHOLDER_TOKENS.has(token.toLowerCase())) {
    fail(`MCP_AUTH_TOKENS : le jeton ${position} est une valeur d'exemple, refuse.`);
  }
  if (new Set(token).size < MINIMUM_TOKEN_ALPHABET) {
    fail(`MCP_AUTH_TOKENS : le jeton ${position} manque d'entropie.`);
  }
  return token;
}

function validateHostnames(entries: readonly string[]): string[] {
  if (entries.length === 0) {
    fail("ALLOWED_HOSTNAMES est obligatoire : indique le hostname public du service MCP.");
  }
  const normalized = entries.map((entry) => entry.toLowerCase());
  for (const hostname of normalized) {
    if (hostname === "*") fail("ALLOWED_HOSTNAMES ne peut pas contenir de joker.");
    if (hostname.includes("/") || hostname.includes(":")) {
      fail(`ALLOWED_HOSTNAMES : "${hostname}" doit être un hostname sans port ni chemin.`);
    }
    if (!HOSTNAME_PATTERN.test(hostname) && !IPV4_PATTERN.test(hostname)) {
      fail(`ALLOWED_HOSTNAMES : "${hostname}" n'est pas un hostname valide.`);
    }
  }
  return [...new Set(normalized)];
}

function validateOrigins(entries: readonly string[]): string[] {
  const normalized = entries.map((entry) => entry.toLowerCase());
  for (const origin of normalized) {
    if (!/^https?:\/\/[a-z0-9.*:[\]-]+$/.test(origin)) {
      fail(`ALLOWED_ORIGINS : "${origin}" doit être une origine exacte, par exemple https://claude.ai.`);
    }
    if (origin.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      fail(`ALLOWED_ORIGINS : "${origin}" doit utiliser https hors boucle locale.`);
    }
  }
  return [...new Set(normalized)];
}

function validatePath(value: string, key: string): string {
  if (!value.startsWith("/") || value.length < 2) fail(`${key} doit être un chemin absolu.`);
  if (value.includes("?") || value.includes("#")) fail(`${key} ne doit pas contenir de requête.`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokens = readList(env, "MCP_AUTH_TOKENS");
  if (tokens.length === 0) {
    fail("MCP_AUTH_TOKENS est obligatoire : au moins un jeton bearer de 32 caractères ou plus.");
  }
  const authTokens = tokens.map(validateToken);
  if (new Set(authTokens).size !== authTokens.length) {
    fail("MCP_AUTH_TOKENS contient un jeton en double.");
  }

  const allowedHostnames = validateHostnames(readList(env, "ALLOWED_HOSTNAMES"));
  const allowedOrigins = validateOrigins(readList(env, "ALLOWED_ORIGINS"));

  const logLevel = (readRaw(env, "LOG_LEVEL") ?? "info").toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    fail(`LOG_LEVEL doit valoir ${LOG_LEVELS.join(", ")}.`);
  }

  const mcpPath = validatePath(readRaw(env, "MCP_PATH") ?? "/mcp", "MCP_PATH");
  const healthPath = validatePath(readRaw(env, "HEALTH_PATH") ?? "/healthz", "HEALTH_PATH");
  if (mcpPath === healthPath) fail("MCP_PATH et HEALTH_PATH doivent être différents.");

  return {
    host: readRaw(env, "HOST") ?? "127.0.0.1",
    port: readInteger(env, "PORT", 8080, 1, 65_535),
    mcpPath,
    healthPath,
    authTokens,
    allowedHostnames,
    allowedOrigins,
    trustProxy: readBoolean(env, "TRUST_PROXY", false),
    maxBodyBytes: readInteger(env, "MAX_BODY_BYTES", 262_144, 1_024, 1_048_576),
    rateLimit: {
      ipPerMinute: readInteger(env, "RATE_LIMIT_IP_PER_MINUTE", 120, 1, 100_000),
      tokenPerMinute: readInteger(env, "RATE_LIMIT_TOKEN_PER_MINUTE", 600, 1, 100_000),
    },
    logLevel,
  };
}
