# artel

The command line interface for the ARTEL platform.

> Early work. `artel auth status`, `artel auth logout`, the whole `artel qa`
> group, `artel game start` and `artel game logout` work today, and
> `ARTEL_TOKEN` is the credential path CI should use. `artel auth login` is
> built against a `POST /api/auth/cli-tokens/exchange` endpoint the
> orchestration server does not have yet, and `artel game start`/`artel game
> logout` are built against a not-yet-settled SDK token mint endpoint — both
> fail, saying exactly that, until the server side lands. `artel projects list`
> below is the shape being built toward.

## What it is for

Running a QA agent against a game, from a terminal or from CI, without opening
the console in a browser.

```
artel auth login
artel projects list
artel game start --build ./Build/Game.exe --project <id>
artel qa run --test-run <id> --instance <id>
artel qa watch <run id>
artel qa show <run id>
artel qa cancel <run id>
artel qa diff <config> <config>
artel game logout --build ./Build/Game.exe --project <id>
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

## Launching a game

**`artel game start --build <path> --project <id>`.** It signs the build in
without the user ever handling an SDK token: this command exchanges the CLI
credential for one, and passes it to the build only through the child
process's `ARTEL_SDK_TOKEN` environment variable — never on the command line,
which is readable by every other user on the machine through `ps`. Everything
else goes as launch arguments: `-artel-server <host:port>` and
`-artel-secure <true|false>` (both derived from `ARTEL_API_BASE_URL`),
`-artel-frontend <url>` (`ARTEL_CONSOLE_BASE_URL`), `-artel-project <id>`, and
`-logFile <path>` pointing at a fresh file under `~/.artel/logs` so a failure
can name exactly where to look. `--width`/`--height` set the window size
(`-screen-width`/`-screen-height`); the launch never carries `-batchmode` (see
below).

The command waits until the build registers with the server, then prints the
resulting game instance id and exits — the build itself keeps running. That id
is what the QA commands (not yet built) take to address this run. If
registration does not happen within `--timeout` seconds (default 60), or the
build exits first, the error says which and names the log file.

**`artel game logout --build <path> --project <id>`.** The session lives in
the game's own platform secret store, not in a file this CLI controls, so only
the game process itself can clear it. This command launches the build with the
same arguments plus `-artel-logout`, waits for it to exit on its own, and
reports the exit code — killing it if it does not exit within `--timeout`
seconds (default 30).

## Running QA

**`artel qa run --test-run <id> --instance <id>`** starts a QA run and, unless
you pass `--no-wait`, follows it until the agent reaches a verdict. Four flags
pin the axes that make two runs comparable: `--model`, `--prompt-version`,
`--reasoning-effort` and `--arch` (a JSON object, or `@path` naming a file that
holds one). They are the same four axes `artel qa diff` selects on, so a run you
just watched can be compared straight away. Leave one out and the server picks;
what it picked comes back in the result either way.

**The exit code is the verdict.** `0` only when the run passed. Failed, cancelled
and *unknown* are all `1`. Unknown is the case worth stating: a run whose socket
died never sends a summary, so it has no verdict at all — not a verdict of zero.
Calling that `0` would let a run that never really finished go green in CI. The
same rule runs `artel qa watch`, which attaches to a run already going.
`artel qa show` never applies it: reading a run is a different question from
whether the game passed, so it exits `0` whatever the verdict.

`--json` on a watching command puts the final result on stdout as one line, the
same shape `artel qa show` prints, and streams the progress to stderr as one
JSON object per line. Without `--json` the same events are human lines on
stderr. Both come from the same event, so the two can never disagree.

**When the event stream drops,** the CLI reconnects from the last event it saw,
five times, backing off from 500ms to 8s, and resets that count whenever an
event arrives. A reconnect loses nothing: the server resumes from the event id.
If the reconnects run out, the CLI asks the server once more how the run is
doing. Already finished — the result is read from the run's log and reported
normally, because a dead socket does not change what the agent decided. Still
going — it fails with `qa_watch_disconnected` and says the run keeps going on
the server. A dropped connection is never reported as a failed test, and never
as a passing one. `--timeout <seconds>` caps the whole wait (default one hour,
`0` for no cap) so a stuck run cannot hold a CI job open forever.

**`artel qa cancel <run id>`** stops a run and frees its game instance.
Scenarios it never reached have no verdict — unknown, not failed.

**`artel qa diff <base> <target>`** puts two configurations side by side. Each
side is a comma-separated selector over the same four axes, written with the
field names the API uses:

```
artel qa diff \
  'model=openai/gpt-5.6-luna,promptVersion=v15' \
  'model=openai/gpt-5.6-luna,promptVersion=v16' --project <id>
```

An axis you leave out matches every value of it, and the matching cells are
added together. That is safe only because `/api/qa-stats` returns sums rather
than ratios: sums can be added, ratios cannot. The CLI keeps that discipline —
`--json` carries the two sums and their difference, not the rendered table, and
every rate the human table prints is derived from those sums with its
denominator shown next to it. A cell whose axes are unknown (a run from before
the server recorded them) never matches a selector that names an axis.

## Two things worth knowing before automating a run

**Do not launch the game with `-batchmode`.** The SDK captures the screen by
reading the back buffer, and batchmode presents none. The capture comes back
blank — grey without a graphics device, black with one — and no error is
raised, so the failure looks like a rendering bug in the game.

**The SDK attaches itself only to a development build.** A release build
carries no SDK unless a scene explicitly places one, and a game without the SDK
cannot be driven.
