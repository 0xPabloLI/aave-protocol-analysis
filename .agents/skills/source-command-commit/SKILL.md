---
name: "source-command-commit"
description: "Verify repo with ci:remote (auto-fix + retry), stage lockfiles if needed, then commit — matches local hook policy"
---

# source-command-commit

Use this skill when the user asks to run the migrated source command `commit`.

## Command Template

# /commit — commit with CI remediation

You are invoked from the **repository root** of this project. Complete a safe commit that survives the same checks as `pre-commit` (`npm run ci:remote` per `AGENTS.md`).

## Before committing

1. Show `git status` and confirm what will be committed. If the user intended specific paths only, stage **only** those (`git add <paths>`). If they want everything, `git add -A` or `git add -u` as appropriate. **Do not commit unrelated unstaged noise** unless the user asked to.

2. **Commit message rules**
   - Conventional style: `type(scope): short subject` (e.g. `fix(backend): …`, `ci: …`).
   - **No URLs** in the message (local `commit-msg` hook rejects them).
   - If the user did not give a message, infer one from the diff; keep it concise.

## Verify (same bar as hooks)

3. From repo root, run:

   ```bash
   npm run ci:remote
   ```

4. If that **fails**, run remediation then verify again (hook policy):

   ```bash
   npm run ci:auto-fix
   npm run ci:remote
   ```

5. If `package-lock.json` or `backend/package-lock.json` changed after step 3–4, **stage them**:

   ```bash
   git add package-lock.json backend/package-lock.json
   ```

   (Only add files that exist and have real changes.)

6. If `ci:remote` still fails after auto-fix (e.g. transitive audit with no fix, build/prune errors), **stop**: report the failing command output and do **not** use `--no-verify` unless the user explicitly asks to bypass hooks.

## Commit

7. Run `git commit` with the agreed message. Do not put URLs in `-m`.

8. Summarize: commit hash, files included, and note if lockfiles were added.

## Push reminder (optional one line)

If lockfiles were staged, remind that `pre-push` blocks when lockfiles are dirty—everything should be in this commit before `git push`.
