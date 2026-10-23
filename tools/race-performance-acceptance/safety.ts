/** Node-only, fail-closed audit of the developer harness's emitted import graph. */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const HARNESS = "tools/race-performance-acceptance/";
const PURE_SOURCE_FILES = new Set([
  "src/components/insights/RacePerformancePanel.tsx",
  "src/lib/trainingAuthorization.ts",
  "src/types/plan.ts",
  "src/types/workoutOverride.ts",
  "src/utils/dates.ts",
  "src/utils/pace.ts",
  "src/utils/performanceEvidence.ts",
  "src/utils/planMatching.ts",
  "src/utils/racePerformance.ts",
  "src/utils/raceTrainingContext.ts",
  "src/utils/riegelFit.ts",
  "src/utils/selectActiveWorkouts.ts",
]);
const SAFE_EXTERNALS = new Set(["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]);
const SDK_IMPORTS: Record<string, ReadonlySet<string>> = {
  "firebase/app": new Set(["initializeApp", "deleteApp", "getApps"]),
  "firebase/auth": new Set([
    "initializeAuth", "inMemoryPersistence", "GoogleAuthProvider", "signInWithPopup",
    "signOut", "onAuthStateChanged", "browserPopupRedirectResolver",
  ]),
  "firebase/firestore/lite": new Set([
    "getFirestore", "collection", "query", "orderBy", "documentId", "limit",
    "getDocs", "doc", "getDoc", "where", "or", "and", "startAfter", "Timestamp",
  ]),
};
const FORBIDDEN_CALLS = new Set([
  "setDoc", "addDoc", "updateDoc", "deleteDoc", "writeBatch", "runTransaction",
  "enableIndexedDbPersistence", "enableMultiTabIndexedDbPersistence", "persistentLocalCache",
  "initializeFirestore", "setPersistence", "getAuth", "eval", "Function", "require",
]);

export interface AcceptanceImportAuditOptions {
  repoRoot: string;
  entryPoints: string[];
  /** The actual Vite replacement for next/link; no Next runtime is permitted. */
  aliases?: Record<string, string>;
}

export interface AcceptanceImportAudit {
  files: string[];
  runtimeImportCount: number;
  erasedTypeImportCount: number;
}

function runtimeBindings(clause: ts.ImportClause | undefined): string[] | null {
  if (!clause) return null;
  if (clause.isTypeOnly) return [];
  const result: string[] = clause.name ? ["default"] : [];
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return ["*"];
  if (clause.namedBindings) {
    if (clause.namedBindings.elements.length === 0 && !clause.name) return null;
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) result.push(element.propertyName?.text ?? element.name.text);
    }
  }
  return result;
}

/**
 * Only the real panel and its audited pure calculation dependencies may enter
 * from src/. SDK access is confined to the isolated connection leaf and exact
 * named read/auth exports. Erased type-only imports cannot execute acquisition.
 * This checks application wiring; it is not a sandbox for hostile source code.
 */
export function assertAcceptanceImportGraph(options: AcceptanceImportAuditOptions): AcceptanceImportAudit {
  const root = fs.realpathSync(options.repoRoot);
  const visited = new Set<string>();
  let runtimeImportCount = 0;
  let erasedTypeImportCount = 0;
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const fail = (file: string, message: string): never => {
    throw new Error(`Acceptance isolation violation in ${relative(file)}: ${message}`);
  };
  const resolveFile = (candidate: string, importer: string): string => {
    const found = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`, `${candidate}/index.tsx`]
      .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!found) return fail(importer, `unresolved local import ${candidate}`);
    const real = fs.realpathSync(found);
    if (relative(real).startsWith("../") || path.isAbsolute(relative(real))) fail(importer, "import escapes repository");
    return real;
  };
  const visit = (file: string): void => {
    const rel = relative(file);
    if (visited.has(rel)) return;
    if (!PURE_SOURCE_FILES.has(rel) && !rel.startsWith(HARNESS) && rel !== "src/app/globals.css") {
      fail(file, "module is outside the explicit panel/pure-source allowlist");
    }
    if (rel.startsWith(HARNESS) && /(?:^|\/)(?:safety|vite\.config)(?:\.|$)|\.(?:test|spec)\./.test(rel)) {
      fail(file, "Node tooling or tests cannot enter the browser bundle");
    }
    visited.add(rel);
    if (file.endsWith(".css")) return;
    if (!/\.(?:ts|tsx)$/.test(file)) fail(file, "only reviewed TypeScript or CSS modules are permitted");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const isBootstrap = rel === `${HARNESS}bootstrap.ts`;
    const isGuardInstall = (expression: ts.Expression | undefined) => !!expression
      && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      && expression.expression.text === "installRuntimeGuard";
    const guardInstall = source.statements.find(statement =>
      (ts.isExpressionStatement(statement) && isGuardInstall(statement.expression))
      || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => isGuardInstall(declaration.initializer))));
    const importsGuard = source.statements.some(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "./runtimeGuard"
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some(element => !element.isTypeOnly
        && element.name.text === "installRuntimeGuard" && !element.propertyName));
    let bootstrapImports = 0;
    const follow = (specifier: string, names: string[] | null): void => {
      if (names?.length === 0) { erasedTypeImportCount++; return; }
      runtimeImportCount++;
      if (specifier in (options.aliases ?? {})) {
        if (specifier !== "next/link") fail(file, `unexpected runtime alias ${specifier}`);
        visit(resolveFile(path.resolve(root, options.aliases![specifier]), file));
        return;
      }
      if (specifier.startsWith("@/")) {
        visit(resolveFile(path.join(root, "src", specifier.slice(2)), file));
      } else if (specifier.startsWith(".")) {
        visit(resolveFile(path.resolve(path.dirname(file), specifier), file));
      } else if (SAFE_EXTERNALS.has(specifier)) {
        return;
      } else if (rel === `${HARNESS}connection.ts` && SDK_IMPORTS[specifier]) {
        if (!names || names.some(name => !SDK_IMPORTS[specifier].has(name))) {
          fail(file, `SDK import must use approved explicit named exports: ${specifier} (${names?.join(", ") ?? "side effect"})`);
        }
      } else {
        fail(file, `unapproved external dependency ${specifier}`);
      }
    };
    const scan = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (isBootstrap && node.moduleSpecifier.text !== "./runtimeGuard") fail(file, "bootstrap may statically import only its runtime guard");
        follow(node.moduleSpecifier.text, runtimeBindings(node.importClause));
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (node.isTypeOnly) erasedTypeImportCount++;
        else follow(node.moduleSpecifier.text, node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0
          ? node.exportClause.elements.filter(element => !element.isTypeOnly).map(element => element.propertyName?.text ?? element.name.text)
          : null);
      }
      if (ts.isImportEqualsDeclaration(node)) fail(file, "import-equals is not permitted");
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : null;
          if (!isBootstrap || !argument || !ts.isStringLiteral(argument) || argument.text !== "./main"
            || !importsGuard || !guardInstall || guardInstall.end >= node.getStart(source)) {
            return fail(file, "dynamic imports are not permitted except bootstrap's guarded main entry");
          }
          bootstrapImports++;
          follow(argument.text, null);
        }
        const expression = node.expression;
        const callName = ts.isIdentifier(expression) ? expression.text
          : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
        if (callName && FORBIDDEN_CALLS.has(callName)) fail(file, `forbidden runtime call ${callName}`);
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
    if (isBootstrap && bootstrapImports !== 1) fail(file, "bootstrap must load its guarded main entry exactly once");
  };
  for (const entry of options.entryPoints) visit(resolveFile(path.resolve(root, entry), root));
  return { files: [...visited].sort(), runtimeImportCount, erasedTypeImportCount };
}

/** A developer-only directory is safe only while application source cannot reach it. */
export function assertHarnessExcludedFromApplication(repoRoot: string): void {
  const root = fs.realpathSync(repoRoot);
  const walk = (directory: string): void => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(file)) {
        const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const scan = (node: ts.Node): void => {
          if (ts.isStringLiteral(node) && node.text.includes("race-performance-acceptance")) {
            throw new Error(`Developer harness referenced by application source: ${path.relative(root, file)}`);
          }
          ts.forEachChild(node, scan);
        };
        scan(source);
      }
    }
  };
  walk(path.join(root, "src"));
}
