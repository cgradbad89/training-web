// @vitest-environment node
import {describe,it,expect} from "vitest";
import fs from "node:fs";
import {assertResearchImportGraph} from "./safety";
import {assertHarnessExcludedFromApplication,assertAcceptanceImportGraph} from "../safety";
describe("research isolation",()=>{
  it("audits the complete standalone graph without acquisition, persistence or the normal shell",()=>{
    const files=assertResearchImportGraph(process.cwd());expect(files).toContain("src/utils/workoutRaceResearch.ts");
    expect(files.some(f=>f.startsWith("src/services/")||f.includes("firebase"))).toBe(false);
    expect(()=>assertHarnessExcludedFromApplication(process.cwd())).not.toThrow();
  });
  it("keeps the owner-read harness's existing no-write graph and Production exclusions",()=>{
    expect(()=>assertAcceptanceImportGraph({repoRoot:process.cwd(),entryPoints:["tools/race-performance-acceptance/bootstrap.ts"],aliases:{"next/link":"tools/race-performance-acceptance/link.tsx"}})).not.toThrow();
    expect(JSON.parse(fs.readFileSync("tsconfig.build.json","utf8")).exclude).toContain("tools/race-performance-acceptance/**");
    expect(fs.existsSync("src/app/race-confirmation-preview/page.tsx")).toBe(false);
  });
});
