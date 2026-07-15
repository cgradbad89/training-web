# CLAUDE.md — Training Web Dashboard

## Workflow Rules

- **Branch**: Work directly on `main`. If a branch is created automatically, merge it into `main` before pushing.
- **Build**: Run `npm run build` after all changes. On failure, fix and retry. Stop after 3 consecutive failures — output the full error log and make no further changes.
- **Test**: Run `npm test` after a passing build (`vitest run`, 1,374 baseline tests across 92 files — 1,369 passed, 5 skipped; as of the per-mile split full-mile stopped-time exclusion session).
- **Commit**: Stage files by explicit path (`git add PRD.md src/...`). Never use `git add -A`. Commit and push only after build + tests pass.
- **No broken commits**: Do not commit if `npm run build` or `npm test` fail.

## Deploying Firestore Rules

- `firestore.rules` at the repo root is the **canonical source** — never edit rules in the Firebase console without mirroring the change back into the repo and committing it.
- Deploy command (CLI configured via `firebase.json` + `.firebaserc`):
  `firebase deploy --only firestore:rules --project malignant-metro`
- Requires a one-time `firebase login` (the CLI is a global tool, not an app dependency).
- Editing `firestore.rules` does nothing until deployed. Deploys are manual and only happen when a task explicitly authorizes them.

## Local Development

- Local dev uses the Firebase Local Emulator Suite by default to save quota.
- Run `npm run dev:emulators` in one terminal, and `npm run dev` in another.
- To bypass the emulator and connect local dev to production Firestore, set `NEXT_PUBLIC_USE_PROD_FIRESTORE=true` in `.env.local`.
- Production builds (`NODE_ENV !== 'development'`) always use real Firestore, regardless of env vars. This is enforced in code, not just by convention.
- To refresh emulator data from production: `npm run snapshot:export` (reads prod, ~few seconds), then with emulators running, `npm run snapshot:import` (writes to emulator only, safe).

## PRD Maintenance

After every session, update `PRD.md` if any of the following changed:

- New route or page added → Section 2 (Page Inventory)
- New or modified Firestore collection or subcollection → Section 3 (Data Model)
- Domain invariant or calculation changed → Section 4 or 5
- Backlog item completed or discovered → Section 7 (Feature Backlog)
- New sharp edge or gotcha found → Section 6 (Known Sharp Edges)
- New external service or env var added → Section 8

Do **not** update PRD.md for bug fixes or UI-only changes unless they affect architecture.
Commit PRD.md in the same commit as the feature work.

## Required Output Report

End every session with this exact format:

```
Files modified:   [path — one-line reason each]
Files created:    [path — one-line reason each]
Tests:            [new count] new / [total] total
Build:            PASSED or FAILED (paste error if failed)
Deployment:       committed and pushed to main — yes / no
PRD.md updated:   yes — [sections changed] / no — [reason]
Unverifiable:     [items that can't be confirmed from code alone, or "none"]
Deferred:         [anything not completed, or "none"]
```

## Key Constraints

| Item | Value |
|---|---|
| Firebase project | malignant-metro |
| Vercel project ID | prj_4SL79DFdWu56fzRrLSzxCQeA8fRd |
| Vercel team ID | team_tsBCiUJBISkxn8eXQuT6EXkx |
| Production URL | https://training-web-rho.vercel.app |
| Local repo | /Users/johnfolstrom/Desktop/training-web |
| iOS sync repo | cgradbad89/MEA.git — do not modify from this repo |
| Firestore rules | Do not modify without explicit task instruction |
| API keys | `ANTHROPIC_API_KEY` is server-only — never `NEXT_PUBLIC_ANTHROPIC_*` |

## Architecture Quick Reference

```
src/
  app/
    (app)/          # Auth-guarded routes (dashboard, runs, plans, health, etc.)
    api/coach/      # Server-side Anthropic API route
    login/          # Public login page
  components/       # Shared UI components + layout/
  hooks/            # useAuth, useActivities, useUnsavedChanges
  lib/              # firebase.ts, auth.ts, firestore.ts, firebaseAdmin.ts, seedData.ts
  services/         # All Firestore read/write (one file per collection)
  types/            # TypeScript interfaces mirroring Firestore documents
  utils/            # Domain logic: metrics, pace, dates, trainingLoad, riegelFit, etc.
    __tests__/      # Vitest unit tests (1,361 tests across 91 files)
```

**See also**: `PRD.md` — full domain reference (data model, invariants, calculations, backlog, services).
