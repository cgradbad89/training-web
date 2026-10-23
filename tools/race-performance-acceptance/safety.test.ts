// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { assertAcceptanceImportGraph, assertHarnessExcludedFromApplication } from "./safety";

const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "race-acceptance-imports-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}
const entry = "tools/race-performance-acceptance/main.tsx";
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe("isolated acceptance runtime import contract", () => {
  it("admits the real panel and its pure runtime dependencies without an app provider or service", () => {
    const result = assertAcceptanceImportGraph({
      repoRoot: process.cwd(),
      entryPoints: ["src/components/insights/RacePerformancePanel.tsx"],
      aliases: { "next/link": "tools/race-performance-acceptance/link.tsx" },
    });
    expect(result.files).toContain("src/utils/racePerformance.ts");
    expect(result.files).toContain("src/utils/raceTrainingContext.ts");
    expect(result.files.every(file => !/src\/(lib|services|providers|hooks)\//.test(file))).toBe(true);
    expect(result.erasedTypeImportCount).toBeGreaterThan(0);
  });

  it("audits the real connection and parent loader without importing SDK mutation or persistence exports", () => {
    const result = assertAcceptanceImportGraph({
      repoRoot: process.cwd(),
      entryPoints: ["tools/race-performance-acceptance/connection.ts"],
    });
    expect(result.files).toContain("tools/race-performance-acceptance/loader.ts");
    expect(result.files).toContain("src/lib/trainingAuthorization.ts");
    expect(result.files).not.toContain("src/lib/firebase.ts");
    expect(result.files.every(file => !/src\/(services|providers|hooks)\//.test(file))).toBe(true);
  });

  it("audits the complete real bootstrap/main graph after the guard is installed", () => {
    const result = assertAcceptanceImportGraph({
      repoRoot: process.cwd(),
      entryPoints: ["tools/race-performance-acceptance/bootstrap.ts"],
      aliases: { "next/link": "tools/race-performance-acceptance/link.tsx" },
    });
    expect(result.files).toContain("tools/race-performance-acceptance/runtimeGuard.ts");
    expect(result.files).toContain("tools/race-performance-acceptance/main.tsx");
    expect(result.files).toContain("tools/race-performance-acceptance/connection.ts");
    expect(result.files).toContain("src/components/insights/RacePerformancePanel.tsx");
    expect(result.files.some(file => /src\/(services|providers|hooks|app)\//.test(file))).toBe(false);
  });

  it("follows indirect source imports and rejects application Firebase initialization", () => {
    const repoRoot = fixture({
      [entry]: "import './middle';",
      "tools/race-performance-acceptance/middle.ts": "import '@/lib/firebase';",
      "src/lib/firebase.ts": "export const db = {};",
    });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/outside the explicit/);
  });

  it("rejects transitive provider/service imports even when an entry does not mention them", () => {
    const repoRoot = fixture({
      [entry]: "export * from './middle';",
      "tools/race-performance-acceptance/middle.ts": "import '@/services/healthWorkouts';",
      "src/services/healthWorkouts.ts": "export const load = () => [];",
    });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/outside the explicit/);
  });

  it("allows only explicit Lite read exports in the private connection leaf", () => {
    const repoRoot = fixture({
      [entry]: "import './connection';",
      "tools/race-performance-acceptance/connection.ts": "import { getFirestore, getDocs, query, limit } from 'firebase/firestore/lite';",
    });
    expect(assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] }).files).toHaveLength(2);
  });

  it.each(["setDoc", "addDoc", "updateDoc", "deleteDoc", "writeBatch", "runTransaction"])("rejects the mutation export %s even under an import alias", name => {
    const repoRoot = fixture({
      [entry]: "import './connection';",
      "tools/race-performance-acceptance/connection.ts": `import { ${name} as innocuous } from 'firebase/firestore/lite';`,
    });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/approved explicit named exports/);
  });

  it.each([
    "import * as store from 'firebase/firestore/lite';",
    "import { getFirestore } from 'firebase/firestore';",
    "import { getAuth } from 'firebase/auth';",
    "import { indexedDBLocalPersistence } from 'firebase/auth';",
    "import 'firebase/firestore/lite';",
    "import {} from 'firebase/firestore/lite';",
  ])("rejects unbounded, full-SDK and persistent-auth imports: %s", source => {
    const repoRoot = fixture({ [entry]: "import './connection';", "tools/race-performance-acceptance/connection.ts": source });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/isolation violation/);
  });

  it("does not confuse erased type imports with executable dependencies", () => {
    const repoRoot = fixture({ [entry]: "import type { User } from 'firebase/auth'; import { type Race } from '@/types/race'; export const x = 1;" });
    expect(assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] }).erasedTypeImportCount).toBe(2);
  });

  it.each(["import('firebase/firestore')", "require('firebase/firestore')", "new Function('return 1')", "setDoc(null, {})"])("rejects unanalyzable or forbidden runtime calls: %s", source => {
    const repoRoot = fixture({ [entry]: source });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/not permitted|forbidden runtime call/);
  });

  it("does not permit the real Next Link package in the harness", () => {
    const repoRoot = fixture({ [entry]: "import Link from 'next/link';" });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [entry] })).toThrow(/unapproved external dependency next\/link/);
  });

  it("keeps all acceptance infrastructure outside the application's source graph", () => {
    expect(() => assertHarnessExcludedFromApplication(process.cwd())).not.toThrow();
  });

  it("excludes developer acceptance files from the TypeScript configuration used by Next Production builds", () => {
    const repoRoot = process.cwd();
    const nextConfig = fs.readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
    expect(nextConfig).toMatch(/tsconfigPath:\s*["']tsconfig\.build\.json["']/);
    const config = ts.readConfigFile(path.join(repoRoot, "tsconfig.build.json"), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames).toContain(path.join(repoRoot, "src/components/insights/RacePerformancePanel.tsx"));
    expect(parsed.fileNames.some(file => file.includes("/tools/race-performance-acceptance/"))).toBe(false);
  });

  it("fails if application code reaches the developer harness", () => {
    const repoRoot = fixture({ "src/app/page.tsx": "import '../../tools/race-performance-acceptance/connection';" });
    expect(() => assertHarnessExcludedFromApplication(repoRoot)).toThrow(/Developer harness referenced/);
  });

  it("audits the one dynamic boundary only after a top-level runtime guard installation", () => {
    const bootstrap = "tools/race-performance-acceptance/bootstrap.ts";
    const repoRoot = fixture({
      [bootstrap]: "import { installRuntimeGuard } from './runtimeGuard'; export const guard = installRuntimeGuard(); await import('./main');",
      [entry]: "export const rendered = true;",
      "tools/race-performance-acceptance/runtimeGuard.ts": "export const installRuntimeGuard = () => ({});",
    });
    expect(assertAcceptanceImportGraph({ repoRoot, entryPoints: [bootstrap] }).files).toHaveLength(3);
  });

  it.each([
    "import { installRuntimeGuard } from './runtimeGuard'; await import('./main'); const guard = installRuntimeGuard();",
    "import { installRuntimeGuard } from './runtimeGuard'; const guard = installRuntimeGuard(); import './main';",
    "import { installRuntimeGuard } from './runtimeGuard'; const guard = installRuntimeGuard(); await import('./connection');",
    "const installRuntimeGuard = () => ({}); const guard = installRuntimeGuard(); await import('./main');",
  ])("rejects an unguarded or broader bootstrap: %s", bootstrapSource => {
    const bootstrap = "tools/race-performance-acceptance/bootstrap.ts";
    const repoRoot = fixture({
      [bootstrap]: bootstrapSource,
      [entry]: "export const rendered = true;",
      "tools/race-performance-acceptance/runtimeGuard.ts": "export const installRuntimeGuard = () => ({});",
    });
    expect(() => assertAcceptanceImportGraph({ repoRoot, entryPoints: [bootstrap] })).toThrow(/isolation violation/);
  });
});
