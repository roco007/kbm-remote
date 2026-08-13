// Renderer bundle — compiles the React dashboard (src/renderer/) into a
// single static file the main process serves over the file:// protocol.
//
//   dev :   watch for changes
//   build : one-shot (called by `pnpm build` after tsc)
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

await esbuild.build({
  entryPoints: ["src/renderer/index.tsx"],
  outfile: "dist/renderer/bundle.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch,
  // Milestone 6: emit a metafile so bundle composition can be audited
  // (`pnpm bench:bundle` renders the top offenders from it).
  metafile: true,
  logLevel: "info",
}).then((result) => {
  if (result.metafile) {
    // Persist the metafile next to the bundle for `pnpm bench:bundle`.
    import("node:fs").then(({ writeFileSync, mkdirSync }) => {
      mkdirSync("dist/renderer", { recursive: true });
      writeFileSync("dist/renderer/bundle.meta.json", JSON.stringify(result.metafile));
    });
  }
});

if (watch) {
  const ctx = await esbuild.context({
    entryPoints: ["src/renderer/index.tsx"],
    outfile: "dist/renderer/bundle.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css" },
    jsx: "automatic",
    sourcemap: true,
  });
  await ctx.watch();
  console.log("esbuild watching renderer source…");
}
