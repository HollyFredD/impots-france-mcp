/**
 * Adaptateur MCP HTTP, portable hors Cloudflare.
 *
 * Le SDK expose un handler web-standard (Request -> Response), donc aucune
 * dépendance à workerd : le même code tourne sous Node, Bun ou Deno.
 * Le handler sert les deux ères de protocole : 2025 en stateless, 2026 en
 * enveloppe par requête.
 */

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { contract_json, invoke } from "./generated/wasm/fiscal_wasm.js";
import { createFiscalServer, parseContract, type WasmToolResponse } from "./server.js";
import type { Logger } from "./log.js";

export type McpRuntime = {
  readonly handler: McpHttpHandler;
  readonly toolCount: number;
  readonly contractGeneratedAt: string;
  close: () => Promise<void>;
};

export function createMcpRuntime(logger: Logger): McpRuntime {
  const contract = parseContract(contract_json());
  const generatedAt = readGeneratedAt(contract_json());

  const handler = createMcpHandler(
    () =>
      createFiscalServer(contract_json(), (tool, arguments_) =>
        invoke(tool, arguments_) as WasmToolResponse,
      ),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error: Error) => {
        // Nom seulement : le message peut recopier une saisie fiscale.
        logger.error("mcp_handler_error", { errorName: error.name });
      },
    },
  );

  return {
    handler,
    toolCount: contract.tools.length,
    contractGeneratedAt: generatedAt,
    close: async () => {
      await handler.close();
    },
  };
}

function readGeneratedAt(rawContract: string): string {
  const parsed = JSON.parse(rawContract) as { source?: { generated_at?: unknown } };
  const value = parsed.source?.generated_at;
  return typeof value === "string" ? value : "unknown";
}
