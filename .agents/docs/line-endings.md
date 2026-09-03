# Line Endings

## Why

A repository that stores both CRLF and LF produces diffs where every line
changed, which hides the real change from review and overwrites `git blame`.
`core.autocrlf` does not prevent this: its default converts nothing on Linux and
macOS.

## Rule

Store text as LF. Carry `.gitattributes` from the first commit:

```text
* text=auto eol=lf

*.cmd text eol=crlf
*.bat text eol=crlf
```

`text=auto` stores text as LF in the repository and `eol=lf` checks it out as
LF. Windows batch files are the exception: stored as LF, restored as CRLF on
checkout, because `cmd.exe` needs CRLF to run them.

`init-project` installs this file. Add it by hand when a repository was created
without it.

## Existing Repositories

When a repository predates the rule, add `.gitattributes` and renormalize the
index in the same commit:

```bash
git add --renormalize .
```

That commit changes line endings and nothing else. Do not mix it with behavior
or refactoring, and state the affected file count in the body.

Two consequences to expect:

- The commit overwrites `git blame` for every renormalized file. Record its hash
  in `.git-blame-ignore-revs` when blame history matters.
- The working tree keeps its old line endings until the next checkout, so a
  clean `git status` after renormalizing is correct, not a failure.

## Validate

No tracked file may hold CRLF except `*.cmd` and `*.bat`:

```bash
git ls-files -z | xargs -0 -I{} sh -c 'grep -qUIP "\r$" "{}" && echo "{}"'
```

Confirm the change carried nothing but line endings before committing:

```bash
git diff --cached -w --stat
```

An empty result means no content changed.
