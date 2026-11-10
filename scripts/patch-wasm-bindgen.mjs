import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const generatedPath = fileURLToPath(
  new URL("../edge/src/generated/wasm/fiscal_wasm.js", import.meta.url),
);
const generated = await readFile(generatedPath, "utf8");

if (!generated.includes('import * as wasm from "./fiscal_wasm_bg.wasm";')) {
  throw new Error("Unexpected wasm-bindgen wrapper: Wasm import marker not found");
}
if (!generated.includes("__wbg_set_wasm(wasm);")) {
  throw new Error("Unexpected wasm-bindgen wrapper: initialization marker not found");
}

const nodeCompatible = `/* Patched after wasm-pack for a plain Node.js runtime.
 * The generated wrapper imports the .wasm module, which Node cannot resolve.
 * We read the bytes from disk and instantiate them once, at module load.
 * The glue module stays untouched: it only needs __wbg_set_wasm(exports).
 */
import { readFileSync } from "node:fs";
import * as imports from "./fiscal_wasm_bg.js";

const bytes = readFileSync(new URL("./fiscal_wasm_bg.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {
  "./fiscal_wasm_bg.js": imports,
});
imports.__wbg_set_wasm(instance.exports);

export { contract_json, invoke } from "./fiscal_wasm_bg.js";
`;

await writeFile(generatedPath, nodeCompatible, "utf8");
