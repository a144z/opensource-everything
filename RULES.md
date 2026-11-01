# Working rules for this repo

Short list. If a rule is broken, the cycle is not done.

## Every cycle ends with a push

1. `npm run typecheck` -> 0 errors.
2. `npx vitest run` -> all tests pass.
3. `npm run build` -> builds.
4. Leak scan (must print nothing):

```powershell
git ls-files | Where-Object { $_ -match 'blockforge|specs/|MASTER|/docs/|adr/|shapegate|intentc|shapes\.py|ir\.py' }
```

5. Commit and `git push`. Never end a cycle with an unpushed commit.

## What is private (never pushed)

- `blockforge/` and anything it generates specs for
- `sketchup/specs/`
- `MASTER.md`
- every `docs/` and `adr/` folder
- `autocad/`

The only published generated file is
`sketchup/packages/engine/src/commands.gen.ts`, because the app imports it at
runtime. Its spec stays private.

## Git hygiene

- Never `git add -A`. Stage explicit paths.
- `.gitignore` does not protect a path already in the index: `git add` overrides
  it. If a file was staged once, `git rm --cached` it.
- Before a force-push, check the remote does not need the history.

## Code rules

- Every document mutation goes through `Session.execute`. No direct writes.
- The UI layer owns no document state; it subscribes to changes.
- Generated files are machine-written. Fix the generator, not the output.
- Lengths are millimetres in data and in `.fcproj`.
- New dependency needs a reason in the same commit message.

## Files

- Use the editor tools, not PowerShell `Set-Content` for source files: it writes
  a UTF-8 BOM and breaks JSON configs.
- Windows console is cp950; run Python with `-X utf8`.
