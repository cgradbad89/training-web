import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Follow emitted imports, so erased types cannot conceal an executable dependency. */
export function assertSyntheticImportGraph(root: string): string[] {
  const entry = "tools/race-performance-acceptance/syntheticMain.tsx";
  const visited = new Set<string>();
  function visit(file: string) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (visited.has(relative)) return;
    if (/^src\/(?:services|contexts|providers)\//.test(relative)
      || (relative.startsWith("src/hooks/") && relative !== "src/hooks/useUnsavedChanges.ts")
      || /^src\/lib\/(?:firebase|auth|firestore)/.test(relative)
      || relative.startsWith("../")) throw new Error(`Unsafe preview dependency: ${relative}`);
    visited.add(relative);
    const emitted = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, removeComments: true },
      fileName: file,
    }).outputText;
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setDoc|updateDoc|runTransaction)\b/.test(emitted)) {
      throw new Error(`Persistence/network API in ${relative}`);
    }
    const source = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true);
    function follow(specifier: string) {
      if (["react", "react-dom/client", "react/jsx-runtime", "lucide-react"].includes(specifier)) return;
      if (!/^(?:@\/|\.)/.test(specifier)) throw new Error(`Unexpected external dependency: ${specifier}`);
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
