# CLAUDE.md — Training Web Dashboard

## Workflow Rules

- **Branch**: Work directly on `main`. If a branch is created automatically, merge it into `main` before pushing.
- **Build**: Run `npm run build` after all changes. On failure, fix and retry. Stop after 3 consecutive failures — output the full error log and make no further changes.
- **Test**: Run `npm test` after a passing build (`vitest run`, 1,361 baseline tests across 91 files — 1,356 passed, 5 skipped; as of the Run Detail impact-tile best-effort alignment session).
- **Commit**: Stage files by explicit path (`git add PRD.md src/...`). Never use `git add -A`. Commit and push only after build + tests pass.
- **No broken commits**: Do not commit if `npm run build` or `npm test` fail.

## Deploying Firestore Rules

- `firestore.rules` at the repo root is the **canonical source** — never edit rules in the Firebase console without mirroring the change back into the repo and committing it.
- Deploy command (CLI configured via `firebase.json` + `.firebaserc`):
  `firebase deploy --only firestore:rules --project malignant-metro`
- Requires a one-time `firebase login` (the CLI is a global tool, not an app dependency).
- Editing `firestore.rules` does nothing until deployed. Deploys are manual and only happen when a task explicitly authorizes them.

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
