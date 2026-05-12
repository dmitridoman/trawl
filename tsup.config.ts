import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  minify: false,
  sourcemap: false,
  onSuccess: "chmod +x dist/index.js",
});
