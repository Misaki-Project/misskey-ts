# Signup E2E Async Validation Design

## Context

`Misaki-Project/misskey-ts`の`mk-2026.9.1`では、signup E2Eが`packages/frontend/test/e2e/basic.spec.ts:76`で失敗する。productionの`MkSignupDialog.form.vue`はusername availability APIを1秒debounceし、応答まで`usernameState`を`wait`に保つ。一方、testはinvitation code入力直後に`isDisabled()`を一度だけ評価するため、正常な非同期validationを待たずにsubmit buttonをdisabledと判定する。

このfailureは`canDeleteAccount` frontend PR #1の変更箇所と無関係だが、同PRのfrontend E2E checkを停止している。

## Decision

`mk-2026.9.1`を基点に独立PRを作り、E2E testだけを修正する。production code、debounce時間、signup validation条件は変更しない。

`packages/frontend/test/e2e/basic.spec.ts`のsignup成功caseで、invitation code入力後の即時判定:

```ts
test.expect(await page.getByTestId('signup-submit').isDisabled()).toBeFalsy();
```

をPlaywrightのweb-first assertionへ置き換える。

```ts
await test.expect(page.getByTestId('signup-submit')).toBeEnabled();
```

`toBeEnabled()`は既定timeout内でbuttonがenabledになるまでpollする。username availability APIが完了しない、usernameが利用不能、または他のvalidation条件が満たされない場合はtimeoutして失敗するため、testの検証内容は弱くならない。

## Scope

- 変更対象は`packages/frontend/test/e2e/basic.spec.ts`の1 assertionだけとする。
- production component、API mock、timeout設定、workflow、依存関係は変更しない。
- `canDeleteAccount` frontend PR #1にはこの修正を混在させない。
- 修正PRを`mk-2026.9.1`へmerge後、PR #1のmerge refを更新してfrontend checksを再実行する。

## Verification

- 変更前のPR CI logにある`basic.spec.ts:76` failureをRED evidenceとする。
- 変更後はfrontend E2E workflowでsignup成功caseを含むsuiteがpassすることを確認する。
- SPDX、lint、typecheckなどPRで起動する他checkもpassすることを確認する。
- 修正PR merge後、canDeleteAccount PR #1の`E2E tests (frontend)`が同じfailureを起こさずpassすることを確認する。

## Rollback

test-only変更なので、問題があれば修正commitをrevertする。production behaviorへのrollbackは不要である。
