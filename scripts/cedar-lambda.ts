// Stands in for the package's /nodejs entry in the Lambda bundle: the wasm bytes are embedded by
// esbuild (--loader:.wasm=binary) because the deployment zip holds only index.mjs.
import { initSync } from "@cedar-policy/cedar-wasm/web";
import wasm from "../node_modules/@cedar-policy/cedar-wasm/web/cedar_wasm_bg.wasm";

initSync({ module: wasm });

export * from "@cedar-policy/cedar-wasm/web";
