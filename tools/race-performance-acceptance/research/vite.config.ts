import path from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig} from "vite";
import {assertHarnessExcludedFromApplication} from "../safety";
import {assertResearchImportGraph} from "./safety";
const directory=path.dirname(fileURLToPath(import.meta.url));
const repoRoot=path.resolve(directory,"../../..");
assertHarnessExcludedFromApplication(repoRoot);
assertResearchImportGraph(repoRoot);
export default defineConfig({root:directory,envDir:false,publicDir:false,
  resolve:{alias:{"@":path.join(repoRoot,"src")}},
  define:{"process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE":'"true"',"process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV":'"development"'},
  server:{host:"localhost",port:4188,strictPort:true,hmr:false,fs:{allow:[repoRoot]}},
  build:{outDir:"/private/tmp/training-3b2-research-preview",emptyOutDir:true}});
