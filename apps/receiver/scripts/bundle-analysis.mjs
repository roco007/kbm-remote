// Bundle composition report — parses the esbuild metafile emitted by the
// renderer build and prints the largest contributors to bundle size.
//
//   pnpm build && pnpm bench:bundle
import { readFileSync } from "node:fs";

// esbuild writes the metafile next to the outfile in the CWD the build ran from.
const candidates = [
  new URL("../dist/renderer/bundle.meta.json", import.meta.url),
  new URL("../dist/renderer/bundle.js.meta.json", import.meta.url),
  new URL("../bundle.meta.json", import.meta.url),
];
let metafile;
for (const c of candidates) {
  try {
    readFileSync(c);
    metafile = c;
    break;
  } catch {
    /* try next */
  }
}
if (!metafile) throw new Error("no esbuild metafile found — run `pnpm build` first");
const meta = JSON.parse(readFileSync(metafile, "utf8"));
const outputs = Object.values(meta.outputs);
const js = outputs.find((o) => o.entryPoint || o.name === "bundle.js") ?? outputs[0];

const inputs = Object.entries(js.inputs ?? {}).map(([name, info]) => ({
  name,
  bytes: info.bytesInOutput ?? 0,
}));

const total = inputs.reduce((sum, i) => sum + i.bytes, 0);

function groupKey(name) {
  if (name.includes("node_modules")) {
    const m = name.match(/node_modules\/([^/]+\/[^/]+|[^/]+)/);
    return m ? `node_modules/${m[1]}` : "node_modules/?";
  }
  if (name.includes("packages/")) {
    const m = name.match(/packages\/([^/]+)/);
    return m ? `packages/${m[1]}` : "packages/?";
  }
  return "apps/receiver (own code)";
}

const groups = {};
for (const i of inputs) {
  const g = groupKey(i.name);
  groups[g] = (groups[g] ?? 0) + i.bytes;
}

console.log("=== Renderer bundle composition ===");
console.log(`total JS bundle (minified): ${(js.bytes / 1024).toFixed(1)} KB`);
console.log(`unminified input total:   ${(total / 1024).toFixed(1)} KB\n`);

console.log("Top 10 modules by size:");
inputs
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 10)
  .forEach((i) => console.log(`  ${(i.bytes / 1024).toFixed(1).padStart(7)} KB  ${i.name}`));

console.log("\nBy group:");
Object.entries(groups)
  .sort((a, b) => b[1] - a[1])
  .forEach(([g, bytes]) =>
    console.log(`  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${g}`),
  );
