import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
/** Emitted runtime graph only: type imports cannot disguise executable data
 * acquisition. File selection is allowed; network/storage/services are not. */
export function assertResearchImportGraph(root:string){
  const seen=new Set<string>();
  function visit(file:string){
    const rel=path.relative(root,file).split(path.sep).join("/");if(seen.has(rel))return;
    if(rel.startsWith("../")||/^src\/(?:services|contexts|providers|app)\//.test(rel)||/^src\/lib\/(?:firebase|auth|firestore)/.test(rel))throw new Error(`Unsafe research runtime: ${rel}`);
    seen.add(rel);
    const emitted=ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,removeComments:true}}).outputText;
    if(/\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|setDoc|updateDoc|runTransaction|eval)\s*(?:\(|\.)/.test(emitted))throw new Error(`Persistence/network call in ${rel}`);
    const source=ts.createSourceFile(file,emitted,ts.ScriptTarget.Latest,true);
    const follow=(name:string)=>{
      if(["react","react-dom/client","react/jsx-runtime"].includes(name))return;
      if(!/^(?:@\/|\.)/.test(name))throw new Error(`Unexpected research dependency: ${name}`);
      const candidate=name.startsWith("@/")?path.join(root,"src",name.slice(2)):path.resolve(path.dirname(file),name);
      const found=[candidate,candidate+".ts",candidate+".tsx",candidate+"/index.ts"].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
      if(!found)throw new Error(`Missing research import: ${name}`);visit(found);
    };
    const scan=(node:ts.Node)=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))follow(node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)throw new Error("Dynamic imports are not permitted in the isolated research entry");
      ts.forEachChild(node,scan);
    };scan(source);
  }
  visit(path.join(root,"tools/race-performance-acceptance/research/main.tsx"));return [...seen].sort();
}
