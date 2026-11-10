/**
 * Application HTTP pure : (Request -> Response).
 *
 * Aucune dépendance à Node ici, ce qui rend l'ensemble testable sans socket.
 * L'ordre des contrôles est volontaire : routage, puis Host, puis Origin, puis
 * débit par IP, puis authentification, puis débit par jeton, puis MCP.
 */

import { BearerVerifier, unauthorizedResponse } from "./auth.js";
import type { Config } from "./config.js";
import {
  applySecurityHeaders,
  forbiddenResponse,
  hostAllowed,
  methodNotAllowedResponse,
  misdirectedRequestResponse,
  notFoundResponse,
  originAllowed,
  serverErrorResponse,
  unsupportedMediaTypeResponse,
} from "./hardening.js";
import { createLogger, type Logger } from "./log.js";
import { createMcpRuntime, type McpRuntime } from "./mcp.js";
import { FixedWindowLimiter, tooManyRequestsResponse } from "./ratelimit.js";

const MCP_METHODS = "POST, GET, DELETE";

export type ClientContext = {
  readonly ip: string;
  readonly requestId: string;
};

export type App = {
  fetch: (request: Request, client: ClientContext) => Promise<Response>;
  close: () => Promise<void>;
  readonly toolCount: number;
  readonly dataVersion: string;
};

export type CreateAppOptions = {
  readonly logger?: Logger;
  readonly runtime?: McpRuntime;
};

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

function healthPayload(toolCount: number, dataVersion: string): Response {
  return Response.json(
    {
      status: "ok",
      service: "impots-france-mcp",
      toolCount,
      dataVersion,
    },
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export function createApp(config: Config, options: CreateAppOptions = {}): App {
  const logger = options.logger ?? createLogger(config.logLevel);
  const runtime = options.runtime ?? createMcpRuntime(logger);
  const verifier = new BearerVerifier(config.authTokens);
  const ipLimiter = new FixedWindowLimiter(config.rateLimit.ipPerMinute, 60_000);
  const tokenLimiter = new FixedWindowLimiter(config.rateLimit.tokenPerMinute, 60_000);

  const withRequestId = (response: Response, requestId: string): Response => {
    const secured = applySecurityHeaders(response);
    secured.headers.set("x-request-id", requestId);
    return secured;
  };

  const dispatch = async (request: Request, client: ClientContext): Promise<Response> => {
    const url = new URL(request.url);

    if (!hostAllowed(request, config.allowedHostnames)) return misdirectedRequestResponse();
    if (!originAllowed(request, config.allowedOrigins)) return forbiddenResponse();

    const isHealth = url.pathname === config.healthPath;
    const isMcp = url.pathname === config.mcpPath;
    if (!isHealth && !isMcp) return notFoundResponse();

    if (isHealth) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowedResponse("GET, HEAD");
      }
    } else if (!["POST", "GET", "DELETE"].includes(request.method)) {
      return methodNotAllowedResponse(MCP_METHODS);
    }

    const ipDecision = ipLimiter.consume(client.ip);
    if (!ipDecision.allowed) return tooManyRequestsResponse(ipDecision.retryAfterSeconds);

    const auth = verifier.verify(request);
    if (!auth.ok) {
      logger.warn("auth_rejected", { requestId: client.requestId, ip: client.ip });
      return unauthorizedResponse();
    }

    const tokenDecision = tokenLimiter.consume(auth.subject);
    if (!tokenDecision.allowed) {
      logger.warn("token_rate_limited", {
        requestId: client.requestId,
        subject: auth.subject,
      });
      return tooManyRequestsResponse(tokenDecision.retryAfterSeconds);
    }

    if (isHealth) return healthPayload(runtime.toolCount, runtime.contractGeneratedAt);

    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") ?? "";
      if (!JSON_CONTENT_TYPE.test(contentType)) return unsupportedMediaTypeResponse();
    }

    logger.debug("mcp_request", {
      requestId: client.requestId,
      subject: auth.subject,
      method: request.method,
    });
    return runtime.handler.fetch(request);
  };

  return {
    fetch: async (request, client) => {
      try {
        return withRequestId(await dispatch(request, client), client.requestId);
      } catch (error: unknown) {
        logger.error("request_failed", {
          requestId: client.requestId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        return withRequestId(serverErrorResponse(), client.requestId);
      }
    },
    close: async () => {
      await runtime.close();
    },
    toolCount: runtime.toolCount,
    dataVersion: runtime.contractGeneratedAt,
  };
}
