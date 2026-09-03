# artel

The command line interface for the ARTEL platform.

> Early work. `artel auth status` and `artel auth logout` work today, and
> `ARTEL_TOKEN` is the credential path CI should use. `artel auth login` is
> built against a `POST /api/auth/cli-tokens/exchange` endpoint the
> orchestration server does not have yet, so it fails — saying exactly that —
> until the server side lands. The rest of the commands below are the shape
> being built toward.

## What it is for

Running a QA agent against a game, from a terminal or from CI, without opening
the console in a browser.

```
artel auth login
artel projects list
artel run --build ./Build/Game.exe --project <id>
artel qa run --test-run <id> --instance <id>
artel qa watch <run id>
artel qa diff <config> <config>
```

Every command that reports a result also takes `--json`, because the reader is
as often a program or a coding agent as it is a person. That JSON shape is a
contract: a key never disappears, and an unknown value is `null` rather than an
absent field.

## Authenticating

There are two ways to give the CLI a credential, and the first one wins.

**`ARTEL_TOKEN`.** Set it to a CLI token and every command uses it. This is the
path for CI, and it needs no file and no browser. A variable that is set but
empty or blank counts as unset — a job whose secret did not resolve reads as
"not signed in" rather than dying on every command — and `artel auth status`
reports that as `"envVarState": "empty"` so it is not silent.

**`artel auth login`.** It opens the console in a browser, waits on a
`127.0.0.1` callback, and stores the issued token at
`~/.artel/credentials.json` with mode `0600`. Set `ARTEL_CONFIG_DIR` to keep
that file somewhere else. On Windows the file goes to
`%USERPROFILE%\.artel\credentials.json` and leans on the profile ACL, because
NTFS does not enforce POSIX mode bits.

Two environment variables point the CLI at a deployment:
`ARTEL_API_BASE_URL` (required — the orchestration API has no default host yet)
and `ARTEL_CONSOLE_BASE_URL` (defaults to `https://artel.kr`).

`artel auth status` says which credential would be used and where it came from.
It never prints the token; it prints a `fingerprint`, the first 12 hex of
`sha256(token)`, which is enough to tell two machines apart. Reporting "not
signed in" is a successful report, so it exits `0`.

`artel auth logout` deletes the local file and says so. It does **not** revoke
anything on the server — `--json` carries `"serverSideRevoked": false` to say
that in a form a program can read. Revoke a token in the console.

## Two things worth knowing before automating a run

**Do not launch the game with `-batchmode`.** The SDK captures the screen by
reading the back buffer, and batchmode presents none. The capture comes back
blank — grey without a graphics device, black with one — and no error is
raised, so the failure looks like a rendering bug in the game.

**The SDK attaches itself only to a development build.** A release build
carries no SDK unless a scene explicitly places one, and a game without the SDK
cannot be driven.
