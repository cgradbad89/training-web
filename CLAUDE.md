# CLAUDE.md — Training Web Dashboard

## Workflow Rules

- **Branch / delivery**: `main` is protected. Start each implementation task from an up-to-date `origin/main` and create a short-lived task branch before making changes. Never push directly to `main`, force-push to `main`, or attempt to bypass branch protection or required checks. After local validation passes, stage only the explicit intended files, commit and push the task branch, open a PR targeting `main`, wait for all required GitHub checks, and merge only after they pass. If a required check fails because of the task, fix it on the same branch, rerun the applicable local validation, push the correction, and wait for checks again; never merge a knowingly broken PR. After a successful merge, synchronize local `main` with `origin/main`, verify remote `main` contains the intended implementation, and verify no tracked or staged task changes remain. Preserve unrelated local and untracked files throughout.
- **Build**: Run `npm run build` after all changes. On failure, fix and retry. Stop after 3 consecutive failures — output the full error log and make no further changes. If a typecheck reports duplicate identifiers from numbered `.next/types/* 2.ts`-style copies, remove only the numbered copies (or clear `.next`) and prevent the Desktop cloud-sync client from syncing `.next`; these are external file-conflict artifacts, never source files.
- **Test**: Run `npm test` after a passing build (`vitest run`, 1,701 tests across 154 files — 1,689 passed, 12 skipped; as of the 2026-10-05 Phase 2A authenticated-session training retention). Note the suite is only fully timezone-clean at US-Eastern; `bestEffortExtraction.test.ts` fails at other offsets and `paceTrends`/`personalRecords` fail at UTC-11 — pre-existing, unrelated to plan matching. This number drifts — always trust a fresh `vitest run` over this doc, and correct this line when it does. Also watch for stray `.claude/worktrees/*` checkouts inflating the count (vitest's exclude only covers `node_modules`/`.git`); run `git worktree list` if the total looks off.
- **Commit**: Stage files by explicit path (`git add PRD.md src/...`). Never use `git add -A` or `git add .`. Commit and push the task branch only after build + tests pass.
- **No broken commits**: Do not commit if `npm run build` or `npm test` fail.

## Firestore Security Rules — Console Is Authoritative

Firebase Console is the production source of truth for Firestore security rules. The repository `firestore.rules` file is a non-authoritative historical/reference snapshot and may be stale; it must never be used to infer deployed production permissions.

Only the product owner changes production Firestore rules, manually in Firebase Console. Agents must never run `firebase deploy`, `firebase deploy --only firestore:rules`, or any other command that changes Firebase rules or indexes.

If a code change needs a rule update, inspect the current owner-supplied Console rules, report the exact required Console snippet, explain where it belongs and why, and do not apply or deploy it.

**NOT APPLIED — PRODUCT OWNER MUST MAKE THIS CHANGE MANUALLY IN FIREBASE CONSOLE.**

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
PR:               [#number / not created]
GitHub checks:    [passed / failed / pending — details]
Delivery:         merged to main — yes / no
Final main SHA:   [SHA / unavailable]
PRD.md updated:   yes — [sections changed] / no — [reason]
Unverifiable:     [items that can't be confirmed from code alone, or "none"]
Deferred:         [anything not completed, or "none"]
```

## Key Constraints

| Item | Value |
|---|---|
| Training Web authorization | Single owner only: normalized `folstromjohn@gmail.com` with verified Firebase email; authentication alone is insufficient |
| Firebase project | malignant-metro |
| Vercel project ID | prj_4SL79DFdWu56fzRrLSzxCQeA8fRd |
| Vercel team ID | team_tsBCiUJBISkxn8eXQuT6EXkx |
| Production URL | https://training-web-rho.vercel.app |
| Local repo | /Users/johnfolstrom/Desktop/training-web |
| iOS sync repo | cgradbad89/MEA.git — do not modify from this repo |
| Firestore rules | Firebase Console is authoritative; only the product owner may change production rules manually. Agents may inspect/report Console rules but never edit or deploy them. |
| AI Coach credentials | Deployments use Vercel OIDC for AI Gateway; `AI_GATEWAY_API_KEY` is the optional server-only static-key alternative for local/CI use. |

## Architecture Quick Reference

```
src/
  app/
    (app)/          # Auth-guarded routes (dashboard, runs, plans, health, etc.)
    api/coach/      # Server-side Vercel AI SDK / AI Gateway route
    login/          # Public login page
  components/       # Shared UI components + layout/
  hooks/            # useAuth, useActivities, useUnsavedChanges
  lib/              # firebase.ts, auth.ts, firestore.ts, firebaseAdmin.ts, seedData.ts
  services/         # All Firestore read/write (one file per collection)
  types/            # TypeScript interfaces mirroring Firestore documents
  utils/            # Domain logic: metrics, pace, dates, trainingLoad, riegelFit, etc.
    __tests__/      # Vitest tests (full suite: 1,701 tests across 154 files)
```

**See also**: `PRD.md` — full domain reference (data model, invariants, calculations, backlog, services).
