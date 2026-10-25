import React,{useMemo,useState} from "react";
import {isRacePerformanceResearchEnabled} from "@/lib/racePerformanceGate";
import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";
import { estimateWorkoutRaceResearch,researchRaceCutoff,WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import { performanceLocalDate,shiftPerformanceDate } from "@/utils/performanceEvidence";
import { explainWorkoutRemoval } from "@/utils/workoutRaceResearchEvaluation";

const finish=(minutes:number|null)=>minutes===null?"Withheld":`${Math.floor(minutes/60)}h ${String(minutes%60).padStart(2,"0")}m`;
const pace=(seconds:number|null)=>seconds===null?"—":`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}/mi`;
export function ResearchPanel({input}:{input:WorkoutRaceResearchInput}) {
  return isRacePerformanceResearchEnabled()?<ResearchView input={input}/>:<p role="alert">Research output disabled by the Production-off feature gate.</p>;
}
function ResearchView({input}:{input:WorkoutRaceResearchInput}) {
  const [asOf,setAsOf]=useState(input.asOf);
  const [transfer,setTransfer]=useState(input.allowSummaryPaceTransfer);
  const [selection,setSelection]=useState("");
  const effective=useMemo(()=>({...input,asOf,allowSummaryPaceTransfer:transfer}),[input,asOf,transfer]);
  const result=useMemo(()=>estimateWorkoutRaceResearch(effective),[effective]);
  const selectedIds=selection.startsWith("week:")?result.history.runs.filter(r=>r.date>=selection.slice(5)&&r.date<=new Date(Date.parse(selection.slice(5)+"T00:00:00Z")+6*86400000).toISOString().slice(0,10)).map(r=>r.workout.workoutId):selection?[selection]:[];
  const explanation=selectedIds.length?explainWorkoutRemoval(effective,selectedIds):null;
  const maxMiles=Math.max(1,...result.training.weekly.map(w=>w.miles));
  return <article className="research-panel">
    <header><p className="eyebrow">Phase 3B.2 · Research only · Unvalidated</p><h1>Race performance, with the training in view</h1>
      <p>{input.source==="synthetic"?"Invented demonstration — no owner data or athlete accuracy claims.":"Owner parent summaries — research only. Original records stay unchanged."}</p>
      <p>Snapshot captured {input.capturedAt}. {result.retrospective?"Retrospective reconstruction: numeric replay is withheld because this snapshot was captured later.":"This calculation uses only completed observations available within the supplied snapshot."}</p>
      <form onSubmit={e=>{e.preventDefault();const date=String(new FormData(e.currentTarget).get("asOfDate")??"");if(/^\d{4}-\d{2}-\d{2}$/.test(date))setAsOf(date===performanceLocalDate(input.capturedAt,input.timeZone)?input.capturedAt:researchRaceCutoff(shiftPerformanceDate(date,1),input.timeZone));}}><label>As-of date <input name="asOfDate" aria-label="As-of date" type="date" defaultValue={performanceLocalDate(asOf,input.timeZone)} required /></label> <button type="submit">Apply as-of date</button></form>
      <label className="assumption"><input type="checkbox" checked={transfer} onChange={e=>setTransfer(e.target.checked)} /> Explore the unvalidated summary pace-transfer assumption</label>
      <p className="fine">Matched average HR does not prove equal physiological effort. A numerical difference here is a conditional calculation, not proof of fitness improvement.</p>
    </header>
    <section><h2>Current performance comparison</h2><p>Latest eligible anchor: {result.anchor?`${result.anchor.name} · ${result.anchor.raceDate} · ${result.anchor.status.replaceAll("_"," ")}`:"No usable race anchor"}.</p>
      <p>Same-distance benchmark takes precedence; other-distance estimates use fixed Riegel. Riegel: {finish(result.raceEquivalences.riegelMinutes)} · VDOT-style: {finish(result.raceEquivalences.vdotMinutes)}. These are research equivalents.</p>
      <div className="model-grid">{result.models.map(model=><div className="model-card" key={model.method}><p className="eyebrow">Model {model.method} · {model.status.replaceAll("_"," ")}</p><h3>{model.name}</h3><strong>{finish(model.finishMinutes)}</strong><p>{pace(model.paceSecondsPerMile)} · Change from A: {model.adjustmentMinutes===null?"—":`${model.adjustmentMinutes>0?"+":""}${model.adjustmentMinutes} min`}</p><p>{model.reason}</p>{model.assumptions.length>0&&<details><summary>Assumptions and limitations</summary><ul>{model.assumptions.map(a=><li key={a}>{a}</li>)}</ul></details>}</div>)}</div>
    </section>
    <section><h2>Completed training and progression</h2><p><b>{result.modelingRuns.length} runs</b> in the latest {WORKOUT_RESEARCH_POLICY.signalDays} local calendar days · {result.training.recentFourWeeks.miles.toFixed(1)} miles in 4 weeks · {(result.training.recentFourWeeks.miles+result.training.priorFourWeeks.miles).toFixed(1)} miles in 8 weeks.</p>
      <p>Earlier four weeks: {result.training.priorFourWeeks.miles.toFixed(1)} mi. Recent sessions: {result.training.recentFourWeeks.sessions}; running days: {result.training.recentFourWeeks.runningDays}. Longest: {result.training.longestRecentRun?.miles.toFixed(1)??"—"} mi; ≥6 mi run count: {result.training.longRuns.recentCount}; long-run progression: {result.training.longRuns.progressionMiles?.toFixed(1)??"unknown"} mi.</p>
      <p>Observed largest gap: {result.longestObservedGapDays??"unknown"} days; since latest supplied run: {result.daysSinceLatestRun??"unknown"} days. Missing records cannot prove detraining.</p>
      <div aria-label="Eight weeks of completed running mileage" className="week-chart">{result.training.weekly.map(w=><div key={w.weekStart}><span>{w.weekStart}{w.partialWeek?" (partial)":""}</span><div className="bar" style={{width:`${w.miles/maxMiles*100}%`}} /><b>{w.miles.toFixed(1)} mi · {w.sessions} runs</b></div>)}</div>
      <p>Pre-anchor four-week context: {result.anchorTraining?.recentFourWeeks.miles.toFixed(1)??"unknown"} mi. Since anchor: {result.sinceAnchor?.sessions??"—"} supplied runs, {result.sinceAnchor?.miles.toFixed(1)??"—"} mi. These metrics receive no arbitrary finish-time credit.</p>
      <details><summary>Coverage, missing measurements and every included run</summary><p>All supplied eligible history: {result.history.runs.length} runs · {result.history.miles.toFixed(1)} mi · {result.history.dateRange?.first??"unknown"} through {result.history.dateRange?.last??"unknown"}. Older runs remain available for comparison.</p><p>Recent recorded types: {JSON.stringify(result.history.types)}. Type labels report supplied intent; pace alone never proves tempo, intervals or maximal effort.</p><p>Missing in the 56-day signal window: {result.history.missing.heartRate} HR, {result.history.missing.recordedPace} recorded pace, {result.history.missing.route} GPS flag, {result.history.missing.weather} usable weather summaries. Positive distance/time still contribute; derived pace is explicitly a calculation.</p><p>Collection coverage within supplied query scope: {JSON.stringify(input.complete)}.</p>
        <div className="table-scroll"><table><thead><tr><th>Date</th><th>Run / recorded type</th><th>Miles</th><th>Pace</th><th>Mean HR</th></tr></thead><tbody>{result.history.runs.map(r=><tr key={r.workout.workoutId}><td>{r.date}</td><td>{r.workout.workoutId} · {r.recordedType}</td><td>{r.workout.distanceMiles.toFixed(1)}</td><td>{pace(Math.round(r.paceSecondsPerMile/5)*5)}</td><td>{r.workout.avgHeartRate??"missing"}</td></tr>)}</tbody></table></div>
        <h3>Exclusions / collapsed records</h3><ul>{result.history.exclusions.map((e,i)=><li key={i}>{e.workoutId}: {e.reason}</li>)}</ul></details>
    </section>
    <section><h2>Why did the experimental estimate change?</h2><label>Inspect a run or week <select aria-label="Inspect a run or week" value={selection} onChange={e=>setSelection(e.target.value)}><option value="">Choose an input</option><optgroup label="Recorded runs">{result.modelingRuns.map(r=><option key={r.workout.workoutId} value={r.workout.workoutId}>{r.date} · {r.recordedType} · {r.workout.workoutId}</option>)}</optgroup><optgroup label="Weeks">{result.training.weekly.map(w=><option key={w.weekStart} value={"week:"+w.weekStart}>{w.weekStart}</option>)}</optgroup></select></label>
      <p>This removes selected inputs from the same snapshot and recomputes. It is a sensitivity check, not a claim about a historical forecast.</p>
      {explanation&&<div role="status"><p>Removing {explanation.features.sessions} signal-window runs changes 4-week mileage by {explanation.features.miles.toFixed(1)} mi and matched pairs by {explanation.features.matchedPairs}.</p>{explanation.models.map(m=><p key={m.method}>Model {m.method}: {finish(m.withMinutes)} with inputs; {finish(m.withoutMinutes)} without; effect {m.effectMinutes??"unavailable"} min. {m.withoutReason}</p>)}<p>{explanation.warning}</p></div>}
      <ul>{result.contributions.map(c=><li key={c.feature}><b>{c.feature}</b>: {c.role.replaceAll("_"," ")} · {c.minutes===null?"no numerical credit":`${c.minutes} min`}. {c.explanation}</li>)}</ul>
      <details><summary>Exact matched-workout contributions ({result.pairs.length})</summary><div className="table-scroll"><table><thead><tr><th>Baseline run</th><th>Recent run</th><th>Pace ratio</th><th>HR difference</th></tr></thead><tbody>{result.pairs.map(p=><tr key={p.recentId}><td>{p.baselineId}</td><td>{p.recentId}</td><td>{p.paceRatio.toFixed(3)}</td><td>{p.heartRateDifference}</td></tr>)}</tbody></table></div><pre>{JSON.stringify({policy:WORKOUT_RESEARCH_POLICY,rejected:result.pairRejections},null,2)}</pre></details>
    </section>
    <section><h2>{result.future.targetName} · March 20, 2027</h2><p>{result.future.reason}</p><p>No future planned mileage, goal pace or completion assumption enters these current calculations.</p></section>
    <section><h2>Validation status and method evidence</h2><p>No athlete-specific accuracy or personalized confidence interval is established. Historical replay needs independently preserved pre-race snapshots and held-out maximal outcomes; client-writable confirmation chronology remains untrusted.</p>
      <p>Research basis: <a href="https://pubmed.ncbi.nlm.nih.gov/2246166/">Morton, Fitz-Clarke &amp; Banister (1990)</a> describes calibrated fitness/fatigue responses. <a href="https://repub.eur.nl/pub/127621">Fokkema et al. (2020)</a> links training volume/endurance to cohort race performance; it does not establish an individual causal time credit. <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4041935/">The 2014 half-marathon cohort study</a> uses training speed plus body-fat measurements, with broad individual errors. Those measurements/calibration are unavailable here.</p>
      <ul>{result.limitations.map(s=><li key={s}>{s}</li>)}</ul>
    </section>
  </article>;
}
