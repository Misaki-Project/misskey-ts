# Signup E2E Async Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** signup E2Eがdebounceされたusername availability確認を正しく待ち、`mk-2026.9.1`とcanDeleteAccount frontend PRのCIをgreenにする。

**Architecture:** production codeは変更せず、既存signup成功testの即時boolean評価をPlaywrightのweb-first assertionへ置き換える。修正は独立PRとして`mk-2026.9.1`へmergeし、その後canDeleteAccount PR #1を更新して同じE2E failureが解消したことを確認する。

**Tech Stack:** TypeScript、Playwright、pnpm 11.25.0、GitHub Actions

## Global Constraints

- 変更先は`Misaki-Project/misskey-ts`だけとし、`shiroha-a/misskey-ts`へpush、PR、設定変更を行わない。
- branchは`fix/signup-e2e-wait`、baseは`mk-2026.9.1` commit `71367bfef82c68b93e99fac2f8efc746a7c42735`とする。
- production component、API mock、debounce時間、timeout設定、workflow、依存関係、lockfileを変更しない。
- code変更は`packages/frontend/test/e2e/basic.spec.ts`の1 assertionだけとする。
- `canDeleteAccount` frontend PR #1へこのtest修正を直接追加しない。
- 即時`isDisabled()`評価を`await test.expect(locator).toBeEnabled()`へ置き換え、Playwright既定timeoutを使う。
- force-pushとcommit amendを行わない。
- `implementer` subagentは使用せず、subagent実行時は`general`を使う。

---

### Task 1: Replace The Immediate Signup Assertion

**Files:**
- Modify: `packages/frontend/test/e2e/basic.spec.ts:76`
- Create: `docs/superpowers/plans/2026-09-25-signup-e2e-wait.md`
- Preserve: `docs/superpowers/specs/2026-09-25-signup-e2e-wait-design.md`

**Interfaces:**
- Consumes: `page.getByTestId('signup-submit')`
- Produces: a web-first enabled-state assertion that waits for async username validation

- [ ] **Step 1: Record the existing RED evidence**

Read the failed canDeleteAccount PR check:

```powershell
gh run view 36026716680 --repo Misaki-Project/misskey-ts --job 107725010235 --log-failed
```

Expected: `packages/frontend/test/e2e/basic.spec.ts:76` fails because `isDisabled()` returns `true` immediately after invitation code input.

- [ ] **Step 2: Make the one-line test correction**

Replace only this line:

```ts
test.expect(await page.getByTestId('signup-submit').isDisabled()).toBeFalsy();
```

with:

```ts
await test.expect(page.getByTestId('signup-submit')).toBeEnabled();
```

Do not add an explicit timeout or sleep. The assertion must fail if the button never becomes enabled within Playwright's configured default timeout.

- [ ] **Step 3: Run static verification**

Install dependencies if this worktree has no `node_modules`, then run:

```powershell
corepack pnpm install --frozen-lockfile
node scripts/check-spdx.mjs --ci
corepack pnpm --filter frontend typecheck
corepack pnpm --filter frontend eslint
git diff --check
```

Expected: all commands PASS and `pnpm-lock.yaml` remains unchanged.

- [ ] **Step 4: Confirm the implementation diff is exactly one assertion**

```powershell
git diff -- packages/frontend/test/e2e/basic.spec.ts
git status --short
```

Expected: `basic.spec.ts` has one removed assertion and one added assertion. The only other uncommitted file is this implementation plan.

- [ ] **Step 5: Commit, push, and open the independent PR**

```powershell
git add packages/frontend/test/e2e/basic.spec.ts docs/superpowers/plans/2026-09-25-signup-e2e-wait.md
git diff --cached --check
git commit -m "Fix test: wait for signup validation"
git push -u origin fix/signup-e2e-wait
gh pr create --repo Misaki-Project/misskey-ts --base mk-2026.9.1 --head fix/signup-e2e-wait --title "Fix signup E2E async validation wait" --body "## Summary`n- wait for the debounced username availability check before asserting signup submit is enabled`n- leave production signup behavior unchanged`n`n## Context`nUnblocks https://github.com/Misaki-Project/misskey-ts/pull/1 and https://github.com/Misaki-Project/mk/issues/9.`n`n## Verification`n- existing RED: basic.spec.ts:76 failed because the immediate isDisabled() read returned true`n- node scripts/check-spdx.mjs --ci`n- frontend typecheck`n- frontend eslint"
```

Expected: an independent PR in `Misaki-Project/misskey-ts` with only the spec, plan, and one-line E2E correction. No upstream PR is created.

### Task 2: Verify, Merge, And Refresh canDeleteAccount PR

**Files:**
- No additional source changes

**Interfaces:**
- Consumes: merged signup E2E fix PR
- Produces: updated `mk-2026.9.1` containing the async wait
- Produces: canDeleteAccount PR #1 with a refreshed merge branch and green frontend E2E

- [ ] **Step 1: Wait for every fix-PR check**

```powershell
$fixPr = gh pr list --repo Misaki-Project/misskey-ts --state open --head fix/signup-e2e-wait --json number,url | ConvertFrom-Json
gh pr checks --repo Misaki-Project/misskey-ts $fixPr[0].number --watch
```

Expected: all non-skipped checks PASS, including `E2E tests (frontend)`. If the same signup assertion fails, stop and return to root-cause investigation; do not merge.

- [ ] **Step 2: Review the final fix PR scope**

```powershell
gh pr diff --repo Misaki-Project/misskey-ts $fixPr[0].number
gh pr view --repo Misaki-Project/misskey-ts $fixPr[0].number --json mergeable,mergeStateStatus,files,commits
```

Expected: production code, workflow, dependency, and lockfile are absent. The only source change is the assertion in `basic.spec.ts`; docs contain the approved spec and plan.

- [ ] **Step 3: Merge the independent fix PR**

```powershell
gh pr merge --repo Misaki-Project/misskey-ts $fixPr[0].number --merge --delete-branch
gh pr view --repo Misaki-Project/misskey-ts $fixPr[0].number --json state,mergedAt,mergeCommit,url
```

Expected: state `MERGED` and a non-empty merge commit on `mk-2026.9.1`.

- [ ] **Step 4: Refresh canDeleteAccount PR #1 with the new base**

```powershell
gh pr update-branch 1 --repo Misaki-Project/misskey-ts
gh pr view 1 --repo Misaki-Project/misskey-ts --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup
```

Expected: PR #1 head/merge branch includes the new base commit and a fresh check suite starts. This server-side base merge must not rewrite or force-push the feature branch.

- [ ] **Step 5: Verify canDeleteAccount PR #1 is unblocked**

```powershell
gh pr checks 1 --repo Misaki-Project/misskey-ts --watch
```

Expected: all non-skipped checks PASS, including `E2E tests (frontend)`. Do not merge PR #1 here; the parent canDeleteAccount Task 5 owns its merge, tag, assets publication, and mk pin update.

- [ ] **Step 6: Record the handoff evidence**

```powershell
gh pr view 1 --repo Misaki-Project/misskey-ts --json url,state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup
git status --short --branch
git log --oneline -5
```

Expected: fix worktree is clean, the fix PR is merged, and canDeleteAccount PR #1 is open and green for Task 5 to resume.
