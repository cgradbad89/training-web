import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {isRacePerformanceEnabled} from "@/lib/racePerformanceGate";
import {normalizeWorkoutResearchExport} from "@/utils/workoutResearchInput";
import {createResearchDemo} from "./fixtures";
import {ResearchPanel} from "./ResearchPanel";

function ResearchApp(){
  const [input,setInput]=useState(createResearchDemo);
  const [error,setError]=useState("");
  const [generation,setGeneration]=useState(0);
  if(!isRacePerformanceEnabled())return <p role="alert">Research output disabled by the Production-off feature gate.</p>;
  return <><aside className="research-import"><b>Isolated developer preview</b><p>No sign-in, backend connection, browser storage or data writes. Load an existing parent-only JSON export in memory, or review the invented example.</p><label>Existing offline parent export <input type="file" accept="application/json,.json" onChange={async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try{const next=normalizeWorkoutResearchExport(JSON.parse(await file.text()));setInput(next);setGeneration(v=>v+1);setError("");}catch(err){setError(err instanceof Error?err.message:String(err));}
  }}/></label><button type="button" onClick={()=>{setInput(createResearchDemo());setGeneration(v=>v+1);setError("");}}>Reset invented example</button>{error&&<p role="alert">{error}</p>}</aside><ResearchPanel key={generation} input={input}/></>;
}
createRoot(document.getElementById("root")!).render(<ResearchApp/>);
