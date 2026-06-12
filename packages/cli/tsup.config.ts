import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  shims: true,
  clean: true,
  dts: false,
  sourcemap: true,
  // The CLI runs as Node 22+ ESM. tsup handles the banner-free ESM build.
});
