import React,{act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {ResearchPanel} from "./ResearchPanel";
import {createResearchDemo} from "./fixtures";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
beforeEach(()=>{vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE","true");vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV","preview");});
afterEach(()=>{act(()=>root?.unmount());container?.remove();vi.unstubAllEnvs();});
function mount(){container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);act(()=>root.render(<ResearchPanel input={createResearchDemo()}/>));}
describe("research model comparison",()=>{
  it("cannot render numerical research in Production even with the opt-in",()=>{
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV","production");mount();
    expect(container.textContent).toContain("disabled");expect(container.textContent).not.toContain("2h");
  });
  it("shows experimental numbers, contributing pairs, all-run context and a withheld future forecast",()=>{
    mount();expect(container.textContent).toContain("2h 10m");expect(container.textContent).toContain("2h 05m");
    expect(container.textContent).toContain("Invented demonstration");expect(container.textContent).toContain("Unvalidated");
    expect(container.textContent).toContain("March 20, 2027");expect(container.textContent).toContain("future race forecast is withheld");
    expect(container.textContent).toContain("invented-after-5");expect(container.textContent).toContain("no numerical credit");
  });
  it("toggles the assumption and explains a selected run without persistence",()=>{
    mount();act(()=>(container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(container.textContent).not.toContain("2h 05m");expect(container.textContent).toContain("not explicitly selected");
    const select=container.querySelector("select")!;
    act(()=>{select.value="invented-recovery";select.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(container.querySelector('[role="status"]')?.textContent).toContain("effect 0 min");
  });
  it("withholds numerical retrospective views instead of leaking a later snapshot",()=>{
    mount();const input=container.querySelector('input[type="date"]') as HTMLInputElement;
    act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"2026-10-01");input.dispatchEvent(new Event("input",{bubbles:true}));});
    act(()=>container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(container.textContent).toContain("Retrospective reconstruction");expect(container.textContent).not.toContain("2h 05m");
  });
});
