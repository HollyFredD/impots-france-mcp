/**
 * Variante stdio, pour un client local (Claude Desktop, par exemple).
 *
 * Aucune authentification ici : le canal est le tube du processus, il ne
 * traverse pas le réseau. L'exposition distante passe par index.ts.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { contract_json, invoke } from "./generated/wasm/fiscal_wasm.js";
import { createFiscalServer, type WasmToolResponse } from "./server.js";

serveStdio(() =>
  createFiscalServer(contract_json(), (tool, arguments_) =>
    invoke(tool, arguments_) as WasmToolResponse,
  ),
);
