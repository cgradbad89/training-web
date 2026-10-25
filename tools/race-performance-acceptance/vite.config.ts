import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { assertAcceptanceImportGraph, assertHarnessExcludedFromApplication } from './safety';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, '../..');
assertHarnessExcludedFromApplication(repoRoot);
const audit = assertAcceptanceImportGraph({ repoRoot, entryPoints: ['tools/race-performance-acceptance/bootstrap.ts'], aliases: { 'next/link': 'tools/race-performance-acceptance/link.tsx' } });
console.log(`Acceptance import audit passed: ${audit.files.length} modules; no normal shell/default Firebase/services.`);
const configPath = process.env.ACCEPTANCE_PUBLIC_CONFIG;
if (!configPath) throw new Error('Set ACCEPTANCE_PUBLIC_CONFIG to the explicit public client configuration JSON path. Environment files are never loaded.');
const publicConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (publicConfig.projectId !== 'malignant-metro') throw new Error('Unexpected Firebase project');
const cssDirectory = path.join(repoRoot, '.next/static/css');
const cssFiles = fs.readdirSync(cssDirectory).filter(name => name.endsWith('.css'));
if (!cssFiles.length) throw new Error('Build Next first; actual panel styling is required');
const css = cssFiles.map(name => fs.readFileSync(path.join(cssDirectory, name), 'utf8')).join('\n');
export default defineConfig({
  root: directory,
  envDir: false,
  publicDir: false,
  define: { 'process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE': '"true"', 'process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV': '"development"' },
  resolve: { alias: { '@': path.join(repoRoot, 'src'), 'next/link': path.join(directory, 'link.tsx') } },
  server: { host: 'localhost', port: 4186, strictPort: true, hmr: false, fs: { allow: [repoRoot] } },
  plugins: [{ name: 'isolated-acceptance-only', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/acceptance-config.json') { response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(publicConfig)); return; }
      if (request.url === '/acceptance.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      next();
    });
  } }],
});
