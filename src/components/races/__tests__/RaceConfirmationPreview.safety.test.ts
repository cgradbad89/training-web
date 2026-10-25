// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Follow emitted imports, so erased types cannot conceal an executable dependency. */
function previewRuntimeGraph(entry: string): string[] {
  const root = process.cwd();
  const visited = new Set<string>();
  function visit(file: string) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (visited.has(relative)) return;
    expect(relative).not.toMatch(/^src\/(?:services|contexts|providers)\//);
    if (relative.startsWith("src/hooks/")) expect(relative).toBe("src/hooks/useUnsavedChanges.ts");
    expect(relative).not.toMatch(/^src\/lib\/(?:firebase|auth|firestore)/);
    visited.add(relative);
    const emitted = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, removeComments: true },
      fileName: file,
    }).outputText;
    expect(emitted).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setDoc|updateDoc|runTransaction)\b/);
    const source = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true);
    function follow(specifier: string) {
      if (["react", "react/jsx-runtime", "lucide-react"].includes(specifier)) return;
      expect(specifier, `Unexpected external dependency in ${relative}`).toMatch(/^(?:@\/|\.)/);
      const candidate = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
      const found = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`, `${candidate}/index.tsx`]
        .find(name => fs.existsSync(name) && fs.statSync(name).isFile());
      if (!found) throw new Error(`Unresolved preview import: ${specifier}`);
      visit(found);
    }
    function scan(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument)) throw new Error("Uninspectable dynamic preview import");
        follow(argument.text);
      }
      ts.forEachChild(node, scan);
    }
    scan(source);
  }
  visit(path.join(root, entry));
  return [...visited];
}

describe("synthetic preview runtime isolation", () => {
  it("uses the real editor and pure evidence helpers without any Firebase, data service or browser storage", () => {
    const files = previewRuntimeGraph("src/components/races/RaceConfirmationPreview.tsx");
    expect(files).toContain("src/components/races/RaceConfirmationEditor.tsx");
    expect(files).toContain("src/utils/raceConfirmation.ts");
    expect(files).toContain("src/utils/racePerformance.ts");
  });

  it("keeps the synthetic route outside the authenticated app layout and root's eager auth graph", () => {
    const rootLayout = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(rootLayout).toContain("AppAuthBoundary");
    expect(rootLayout).not.toContain("AuthContext");
    expect(fs.existsSync("src/app/(app)/race-confirmation-preview/page.tsx")).toBe(false);
    const route = fs.readFileSync("src/app/race-confirmation-preview/page.tsx", "utf8");
    expect(route.indexOf("notFound();")).toBeLessThan(route.indexOf("await import("));
  });
});
