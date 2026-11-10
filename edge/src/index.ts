/**
 * Point d'entrée du serveur HTTP MCP auto-hébergé.
 *
 * Conçu pour tourner derrière Pangolin (Newt + Traefik) : le processus écoute
 * sur le réseau interne du conteneur, aucun port public n'est nécessaire.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { ConfigError, readConfig } from "./config.js";
import { applySecurityHeaders, payloadTooLargeResponse, serverErrorResponse } from "./hardening.js";
import { createLogger } from "./log.js";
import {
  BodyTooLargeError,
  clientAddress,
  sendWebResponse,
  toWebRequest,
} from "./node-adapter.js";

function routeLabel(path: string, mcpPath: string, healthPath: string): string {
  if (path === mcpPath) return "mcp";
  if (path === healthPath) return "health";
  return "other";
}

function start(): void {
  const config = readConfig(process.env);
  const logger = createLogger(config.logLevel);
  const app = createApp(config, { logger });

  const server = createServer(
    {
      // Les flux SSE peuvent rester ouverts : pas de coupure globale.
      requestTimeout: 0,
      headersTimeout: 20_000,
      keepAliveTimeout: 65_000,
    },
    (request: IncomingMessage, response: ServerResponse) => {
      void handle(request, response);
    },
  );

  server.maxHeadersCount = 100;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const ip = clientAddress(request, config.trustProxy);
    const startedAt = performance.now();
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    let status = 500;

    try {
      const webRequest = await toWebRequest(request, {
        maxBodyBytes: config.maxBodyBytes,
        requestId,
        trustProxy: config.trustProxy,
      });
      const webResponse = await app.fetch(webRequest, { ip, requestId });
      status = webResponse.status;
      await sendWebResponse(response, webResponse);
    } catch (error: unknown) {
      if (response.headersSent) {
        // Réponse déjà entamée : on coupe plutôt que d'écrire un corps invalide.
        logger.error("response_truncated", { requestId });
        response.destroy();
        return;
      }
      if (error instanceof BodyTooLargeError) {
        status = 413;
        const limited = applySecurityHeaders(payloadTooLargeResponse(config.maxBodyBytes));
        limited.headers.set("x-request-id", requestId);
        await sendWebResponse(response, limited);
      } else {
        logger.error("unhandled_error", {
          requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        const fallback = applySecurityHeaders(serverErrorResponse());
        fallback.headers.set("x-request-id", requestId);
        await sendWebResponse(response, fallback);
      }
    } finally {
      logger.info("http_request", {
        requestId,
        ip,
        method: request.method ?? "GET",
        route: routeLabel(path, config.mcpPath, config.healthPath),
        status,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };

  server.on("clientError", (_error, socket) => {    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  server.on("error", (error: Error) => {
    logger.error("server_error", { errorName: error.name });
    process.exitCode = 1;
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_begin", { signal });
    const forced = setTimeout(() => {
      logger.error("shutdown_forced");
      process.exit(1);
    }, 10_000);
    forced.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    logger.info("shutdown_complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  server.listen(config.port, config.host, () => {
    logger.info("listening", {
      host: config.host,
      port: config.port,
      tools: app.toolCount,
      dataVersion: app.dataVersion,
      tokens: config.authTokens.length,
      hostnames: config.allowedHostnames.join(","),
    });
    if (config.host !== "127.0.0.1" && config.host !== "::1") {
      logger.warn("listening_non_loopback", {
        hint: "Vérifie qu'aucun port n'est publié hors du réseau Docker.",
      });
    }
  });
}

try {
  start();
} catch (error: unknown) {
  const message = error instanceof ConfigError ? error.message : "Configuration invalide.";
  console.error(JSON.stringify({ level: "error", event: "startup_failed", message }));
  process.exit(1);
}
