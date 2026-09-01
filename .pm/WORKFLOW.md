# Training Web PM Harness Workflow

## Project identity and authority sources

This repository is the private single-owner training and fitness dashboard. It is a Next.js App Router application using React, TypeScript, Tailwind CSS, Firebase Authentication/Firestore, Firebase Admin, Vercel AI Gateway, charts/maps, weather data, and data synchronized from a separate iOS HealthKit application.

For every run, follow the explicit milestone and this project-wide workflow. The milestone may come from a local file or an authenticated owner Slack New Task; a repository milestone file is not required for Slack work. Within the repository, consult `CLAUDE.md`, `PRD.md`, `README.md` when present, applicable design/audit documents, configuration, and then code and tests. `PRD.md` is the technical and domain reference for routes, Firestore paths, date and training invariants, calculations, external services, known sharp edges, and backlog. Report material conflicts or missing acceptance criteria as `OWNER_REQUIRED`; do not silently establish new fitness, data, or security policy.

The repository uses npm and a committed lockfile. The CI quality gate uses Node 22 and is the canonical runtime reference for reproducible harness validation. Do not change the runtime, package manager, framework, dependency policy, or lockfile unless the milestone explicitly authorizes it; required network or compatibility decisions are `OWNER_REQUIRED`.

## Role authority

- The PM is read-only. It captures the immutable baseline, interprets the milestone, assigns bounded work, evaluates evidence, and reevaluates failures. It must not edit, stage, commit, deploy, or mutate external systems.
- The Implementer is the only role allowed to make bounded working-tree changes. It may edit only unprotected paths inside this repository that are necessary for the accepted milestone and may run the local deterministic checks described below.
- The Verifier is fresh, independent, and read-only. It inspects the actual diff and baseline, tests the acceptance criteria, and reports PASS or FAIL with command evidence. It must not repair the implementation or expand scope.
- Only the PM may conclude `READY_FOR_OWNER_REVIEW`, and only after an independent Verifier PASS.

## Allowed repository work

- Make the smallest coherent source, test, style, or documentation change required by the milestone.
- Preserve canonical owner authorization, private server-route authorization, `users/{uid}` data ownership, documented legacy exceptions, Firestore read/write boundaries, server/client separation, date/time semantics, plan matching, training calculations, cache freshness, and source-data provenance in `PRD.md`.
- Add or update focused regression tests when behavior changes. Do not weaken, delete, skip, or bypass tests or validation to obtain a pass.
- Update `PRD.md` only when the milestone changes documented routes/pages, the data model, domain invariants/calculations, business logic, backlog status, external-service behavior, or known sharp edges. Ordinary bug fixes and UI-only changes do not require a PRD rewrite unless they change architecture.
- Do not perform unrelated cleanup, broad reformatting, speculative refactors, data repair/backfill, snapshot refresh, dependency upgrades, or toolchain changes. New dependencies and lockfile regeneration require explicit milestone authority and any required network or trust decision requires `OWNER_REQUIRED`.
- Do not modify the separate iOS/HealthKit sync repository (`cgradbad89/MEA.git`) or infer web-side authority over its data writer. Cross-repository changes require a separately authorized milestone.

## Protected owner work and local state

- Before delegation, capture one immutable baseline containing branch, HEAD, tracked changes, untracked paths, and worktree state. Every path already dirty or untracked at that baseline is protected owner work.
- Do not modify, delete, rename, move, format, stage, reset, clean, stash, or silently adopt protected owner work. An unusual name, duplicate-looking file, debug log, or local configuration file is not evidence that it is disposable.
- Numbered conflict copies may be removed only when they are generated `.next/types/* 2.ts`-style artifacts covered by the narrow rule in `CLAUDE.md`. Numbered files under `src/` are source files, not generated artifacts; if present at baseline they are protected owner work and must not be removed or changed.
- If required milestone work overlaps a protected path, or cannot be distinguished safely from owner work, stop before editing and return `OWNER_REQUIRED` with the exact overlap.
- Do not read, print, copy, edit, or stage secret-bearing files such as `.env.local`, other ignored environment files, Firebase service-account JSON, Vercel credentials, or service tokens. Example/template environment files may be inspected and edited only when explicitly in scope and must contain placeholders, never live values.
- Treat `.vercel/`, `.claude/worktrees/`, local snapshots, logs, `.next/`, coverage, build output, caches, and other ignored artifacts as non-source local state. Validation may regenerate its normal disposable outputs, but agents must not treat those outputs as implementation, stage them, or delete pre-existing local artifacts to make checks pass.
- Never rebaseline after delegation to hide owner changes or unexpected drift. Any non-agent drift after the baseline is `OWNER_REQUIRED`.

## Required validation

Run focused tests for the changed surface first using the existing `npm test` script with the relevant test paths. For application-code changes, the canonical repository gate is:

```text
npm run validate
```

That command runs the committed stack in order: `npm run typecheck`, `npm run lint:ci`, `npm test`, and `npm run build`. Do not substitute the less strict interactive lint command for `lint:ci`, raise its committed 104-warning ceiling, exclude changed files, or bypass a failing stage. Run in the repository's documented US-Eastern environment when controlling timezone; never mask a genuine date/time failure by changing assertions or skipping tests. Trust fresh command output over historical test counts in documentation.

Stop after three consecutive attempts at the same failing build or validation problem; preserve the complete useful error evidence and return `OWNER_REQUIRED` rather than cycling or weakening the gate. If duplicate type errors come from numbered source files that were protected at baseline, do not apply the `.next/types` cleanup rule to them; report the blocker.

For a documentation-only or PM Harness authority change, inspect the exact diff and run `git diff --check`; the full application gate is not required unless the milestone changes executable behavior or explicitly asks for it. Never report an unrun command as passed.

`npm run snapshot:export` reads production and `npm run snapshot:import` writes emulator state. They are owner-directed data operations, not ordinary validation. Likewise, env-gated maintenance, backfill, repair, seed, and `commit` modes are excluded from ordinary tests and must not be enabled to obtain evidence.

The Verifier must independently inspect the diff, protected-path baseline, relevant invariants, and test changes, then rerun proportionate deterministic validation where its read-only environment permits. For a full application change, PASS requires credible evidence for the complete `npm run validate` gate and focused evidence for the acceptance criteria.

## Git rules

- Work only in the existing checkout. PM Harness work must not create branches, worktrees, commits, tags, or remotes, even though `CLAUDE.md` describes the repository's ordinary human commit/push flow.
- Do not stage files. Do not run `git add`, including `git add .` or `git add -A`.
- Do not commit, amend, cherry-pick, rebase, merge, push, force-push, fetch-and-integrate, or change upstream/remote configuration.
- Do not rewrite history, delete branches, create tags, or merge to `main` or another protected branch.
- Do not use destructive or owner-state-changing Git operations, including reset, clean, stash, checkout/restore of paths, or any equivalent attempt to discard or conceal work.
- Read-only Git inspection and diff commands are allowed. The owner reviews and decides how to stage, commit, merge, and push after harness completion.

## External systems, data, and deployment

- No autonomous production or preview deployment, Vercel project linking, environment mutation, domain/provider configuration, release, publish, or hosting change. Do not run Vercel deployment commands.
- Never run `firebase deploy`, including any Firestore rules or index deployment. Firebase Console is the production source of truth; the committed `firestore.rules` is a non-authoritative historical/reference snapshot. Only the product owner may change production rules or indexes manually.
- Do not write, delete, migrate, backfill, normalize, seed, or repair production Firebase data. Do not set `NEXT_PUBLIC_USE_PROD_FIRESTORE=true`, enable env-gated write/`commit` modes, or invoke authenticated product endpoints to manufacture verification evidence.
- Do not run `npm run snapshot:export` autonomously because it reads production. `npm run snapshot:import` is limited to a local emulator but still requires an explicit owner-directed snapshot milestone; it is not a general-purpose test setup.
- Do not rotate, reveal, or alter Firebase service accounts, credentials, secrets, OAuth scopes, Google provider configuration, canonical owner identity, billing, account settings, Vercel AI Gateway configuration, or external provider settings.
- Do not make live calls to Vercel AI Gateway, Google Maps, Open-Meteo, or other paid/authenticated services during ordinary implementation or verification. Stub or mock external boundaries in tests.
- The existing local emulator flow (`npm run dev:emulators` with `npm run dev`) may be used only when the milestone needs it and remains fully local. It grants no authority to bypass the emulator, read production, or import owner data.
- A milestone requiring external network access, owner credentials, production reads/writes, irreversible remote decisions, Console inspection/change, or provider-side verification stops at `OWNER_REQUIRED` unless the owner separately performs the action and supplies bounded evidence.

## Approval boundaries and owner stops

PM Harness approval requests are not a route around this contract. Do not request or retry elevated authority for a prohibited action. Return `OWNER_REQUIRED` for any of the following:

- unavoidable overlap with protected owner work, ambiguous ownership, or unexpected workspace drift;
- ambiguous or conflicting product requirements, acceptance criteria, data ownership, date/training semantics, or security behavior;
- authentication/authorization, Firestore rules/indexes, schema/migration, canonical owner identity, secret, billing, provider, or deployment decisions;
- a dependency, runtime, package-manager, lockfile, framework, or external network change without explicit bounded authority;
- production data work, snapshot refresh, migration/backfill/repair/seed/commit modes, or destructive/local cleanup;
- any requested change to the separate iOS/HealthKit sync repository or its production writer;
- a command that requests interactive approval, credentials, broader filesystem access, network access, or external mutation;
- inability to prove the acceptance criteria, a required gate blocked by the environment, or the same validation failure after three reasoned attempts;
- any need to expand the milestone or weaken a safety, test, warning, type, build, or approval boundary.

## Verification and readiness

The Implementer must hand off the exact diff, paths touched, commands run with outcomes, acceptance evidence, and any residual risks. The Verifier must confirm that changes are bounded to the milestone, protected owner work is unchanged, tests genuinely exercise the behavior, repository invariants remain intact, the validation evidence is credible, and no external or Git authority was exercised.

The PM may return `READY_FOR_OWNER_REVIEW` only when:

- every acceptance criterion is satisfied with repository evidence;
- the independent Verifier reports PASS;
- required focused tests and the canonical validation gate passed, with any proportionate omission explicitly justified;
- only intended unprotected repository paths changed and the baseline remains intact;
- required `PRD.md` documentation was updated, or its omission is correctly justified;
- no secret, generated artifact, production data, snapshot, external system, deployment, stage, commit, remote, or iOS repository was changed; and
- there is no unresolved security, data, ownership, scope, date/time, or validation ambiguity.

`READY_FOR_OWNER_REVIEW` means only that the bounded working-tree change is ready for the owner's review. It does not authorize staging, committing, pushing, deploying, production verification, or data synchronization.

## Recovery expectations

On failure, preserve owner work and useful diagnostics, identify the smallest failing command or invariant, distinguish pre-existing failures from milestone regressions using baseline evidence, and let the PM reevaluate. Do not reset, clean, stash, delete local state, broaden the fix, or repeatedly rerun unchanged commands. If safe local recovery is not possible within scope, return `OWNER_REQUIRED` with the exact blocker and the smallest owner action needed.
