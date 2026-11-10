/**
 * Journalisation structurée, volontairement pauvre.
 *
 * Interdits absolus, alignés sur CONTRIBUTING.md :
 * - jamais d'argument d'outil, ni de résultat, ni de corps de requête ;
 * - jamais d'en-tête Authorization, ni de jeton, ni de fragment de jeton ;
 * - jamais de message d'erreur brut : il peut recopier une saisie fiscale.
 */

import type { LogLevel } from "./config.js";

const WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogFields = Record<string, string | number | boolean | undefined>;

export type Logger = {
  error: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  debug: (event: string, fields?: LogFields) => void;
};

const FORBIDDEN_KEYS = new Set([
  "authorization",
  "token",
  "body",
  "arguments",
  "result",
  "query",
  "email",
  "revenu",
]);

function sanitize(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return clean;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = WEIGHT[level];
  const emit = (severity: LogLevel, event: string, fields?: LogFields): void => {
    if (WEIGHT[severity] > threshold) return;
    const line = { ts: new Date().toISOString(), level: severity, event, ...sanitize(fields ?? {}) };
    const target = severity === "error" || severity === "warn" ? console.error : console.log;
    target(JSON.stringify(line));
  };
  return {
    error: (event, fields) => emit("error", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    info: (event, fields) => emit("info", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
  };
}

export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};
