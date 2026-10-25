import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { assertHarnessExcludedFromApplication } from "./safety";
import { assertSyntheticImportGraph } from "./syntheticSafety";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, "../..");
assertHarnessExcludedFromApplication(repoRoot);
assertSyntheticImportGraph(repoRoot);
const cssFiles = ["css", "chunks"].flatMap(folder => {
  const directory = path.join(repoRoot, ".next/static", folder);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".css"))
    .map(name => path.join(directory, name)) : [];
});
const css = cssFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
if (!css) throw new Error("Build Next first for the actual editor styling.");

export default defineConfig({
  root: directory,
  envDir: false,
  publicDir: false,
  resolve: { alias: { "@": path.join(repoRoot, "src") } },
  server: { host: "localhost", port: 4187, strictPort: true, hmr: false, fs: { allow: [repoRoot] } },
  plugins: [{ name: "synthetic-editor-styling", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === "/synthetic.css") {
        response.setHeader("Content-Type", "text/css");
        response.end(css);
        return;
      }
      next();
    });
  } }],
});
