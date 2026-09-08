# artel

The command line interface for the ARTEL platform.

> Early work. `artel auth status`, `artel auth logout`, the whole `artel qa`
> group, `artel game start` and `artel game logout` work today, and
> `ARTEL_TOKEN` is the credential path CI should use. `artel auth login` is
> built against a `POST /api/auth/cli-tokens/exchange` endpoint the
> orchestration server does not have yet, and `artel game start`/`artel game
> logout` are built against a not-yet-settled SDK token mint endpoint — both
> fail, saying exactly that, until the server side lands.

## What it is for

Running a QA agent against a game, from a terminal or from CI, without opening
the console in a browser.

```
artel auth login
artel project list
artel game start --build ./Build/Game.exe --project <id>
artel game list --project <id>
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

## Finding the ids other commands ask for

Almost every command takes `--project`, and `artel qa run` takes `--instance`.
Two commands say what those are, so neither one has to come from a browser.

**`artel project list`** names the projects this credential can see, newest
change first. The server pages this, so the output says how many of the total
came back and which `--page` holds the rest — a list that quietly stopped at 100
would read as "there are only 100".

**`artel game list --project <id>`** names that project's game instances. It
prints whether each one is connected right now, because that is what decides
whether `artel qa run` can drive it; an instance that has gone offline shows when
it was last reachable. An instance exists only after a build carrying the SDK has
registered at least once, so an empty list usually means `artel game start` has
not run yet rather than that something is wrong.

Both are reads: an empty result is a successful report and exits `0`.

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

**The game launches windowed.** Unity reads the full-screen mode it saved last
time unless the launch says otherwise, so without `-screen-fullscreen` a build
comes up full screen and `--width`/`--height` look ignored. This CLI passes
`-screen-fullscreen 0` by default, and `--fullscreen` passes `1`. The default is
windowed because running several builds at once is what this tool is for, and
two full-screen games cover each other.

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

Three more flags open what the agent is allowed to use, rather than how it
thinks. `--content-map-mode` takes `on`, `frozen` or `off`; `--knowledge-mode`
takes `learning`, `frozen` or `off`. They are separate switches on purpose — tied
together, there is no way to tell whether the knowledge store or the content map
was what helped. `--label` names the experiment a run belongs to. **Name the
experiment only.** Which arm it is is already in `run_config`, so writing
`arm:map-only` in the label records the same fact in two places and the two
drift. A flag you leave out is left out of the request entirely, so the server
uses its own default; the CLI never sends an empty string, which the server would
read as a value and reject.

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

## Reading what a run found

A QA run produces two things: a verdict, and the defects it found on the way.
`artel issue` reads and settles the second. These are the run's findings, not
Jira issues.

**`artel issue list --project <id>`** names them newest first, each with the run
and try it came from so `artel qa show <run id>` opens the context. `--status`
and `--severity` are the server's own filters, so they narrow the whole project
rather than the page that came back. The listing is a cursor page: when there is
more, the output says so and prints the `--before` cursor that opens the next
one.

**`artel issue resolve <id>`** and **`artel issue reopen <id>`** change the mark.
The server answers these with an empty `204`, so `--json` reports what the CLI
knows — which issue, which action, and the status that action means — rather than
a re-read of the issue. There is no endpoint that returns one issue, so
`artel issue list` is how you check.

## Running a matrix of configurations

**`artel qa matrix`** expands the cartesian product of the axis lists and runs
every combination, spread over several game builds:

```
artel qa matrix \
  --project 1 \
  --test-run 1,2 \
  --model openai/gpt-5.6-luna \
  --content-map-mode off,frozen \
  --knowledge-mode off \
  --label 2x2-local-pilot \
  --slot /path/to/BuildA/WordVenture.exe \
  --slot /path/to/BuildB/WordVenture.exe
```

That is 2 test runs × 1 model × 2 content map modes × 1 knowledge mode = 4 runs,
spread over 2 slots. The product is expanded in a fixed order — test run, model,
prompt version, reasoning effort, content map mode, knowledge mode — and
combination *i* goes to slot *i mod slots*, so running the same command twice
sends the same combination to the same slot.

**An axis given one value is pinned, not multiplied.** `--model` above does not
add combinations; it makes every run use that model. That is the reason to pass
it even when you are not comparing models: leave it out and the server picks per
run, so a default that changes while the matrix is running puts two models in one
table and nothing in the output says so.

`--model`, `--prompt-version` and `--reasoning-effort` are the same axes
`artel qa diff` selects on, so a matrix can now produce the runs that diff
compares. `artel qa models` lists the ids and the efforts each model takes.

`--reasoning-max-tokens` and `--arch` are fixed values for the whole matrix
rather than axes. The token budget only means something under a chosen model and
effort, so multiplying it against those two produces combinations that do not go
together; `--arch` is one JSON object and cannot be split on commas. A work-stealing queue would finish
sooner but would decide that by timing, and which build a run happened on is part
of the measurement.

**`--repeat n` runs each combination n times.** A QA run is not deterministic:
the same configuration twice does not give the same result. A table with one run
per cell cannot tell whether the difference you see came from the arm or from
that day's luck. The runs stay separate in the output — each carries the
combination it belongs to and which repeat it was — and the human summary adds a
line per combination saying how many of its runs passed. The CLI counts; it does
not average. What sits on top of that count is for whatever reads the list, the
same way `artel qa diff` hands out sums rather than ratios.

**A slot runs one QA run at a time.** Two runs on one game instance do not
overlap — the second ends the first, and the server only allows that with
`force` — so a slot is a work queue, not a parallelism knob.

**The game is relaunched between runs.** If the previous run left the game in a
battle screen, the next run's first step ("observe the title screen") starts
from there and the comparison is no longer between the arms. Each combination
gets a game this command launched and kills when the run ends.

**Each slot needs its own build.** `sdk_uuid` (`ArtelSdkIdentity`) and the game's
`StagePosition` (`SaveLoadController`) both live in `PlayerPrefs`, and on Windows
that store is keyed by `productName`. Two builds that share a `productName` fold
into a single game instance and overwrite each other's saves. This CLI does not
build anything: prepare builds with different `productName` values and pass their
paths. It can only reject the same path twice — two different paths with the same
`productName` are yours to avoid.

Registration is serialized across slots even though the runs are not. The CLI
finds the instance a launch registered by diffing the project's instance list
before and against after, and two launches registering at the same moment land in
the same diff. Registration takes seconds and a run takes minutes, so the wait
costs almost nothing.

**`--out <path>` writes each finished run to a file the moment it finishes,** one
JSON object per line. A matrix that dies at run 7 of 12 leaves the first 6
readable; without it those verdicts existed only in output that is now gone.
`--resume` then skips the runs already in that file and runs the rest, and the
final result is the same shape either way.

`--resume` takes no path of its own — it resumes the file `--out` writes.
Reading one file while writing another would be a state nobody can say the
meaning of.

A run is recognised by its axis values and its repeat number, not by where it sat
in the expansion order. Add one `--model` and every combination's position
shifts, so a position-based key would make `--resume` skip a run that never
happened. If the file holds a run the current axes would never produce, the
command stops before launching anything: resuming onto another experiment's file
would put two experiments in one table.

**One failed combination does not stop the others.** The failure is recorded
against that combination, the slot moves on to its next one, and the summary
lists what failed and why. The exit code is `0` only when every combination
passed — the same rule as `artel qa run`. `--json` puts the whole matrix on
stdout as one line, with `testRunId`, `contentMapMode`, `knowledgeMode`,
`qaRunId`, `status`, the step counts and the elapsed time for each combination;
progress goes to stderr. The CLI never invents an arm name for a combination:
the axis values say what it was.

## Two things worth knowing before automating a run

**Do not launch the game with `-batchmode`.** The SDK captures the screen by
reading the back buffer, and batchmode presents none. The capture comes back
blank — grey without a graphics device, black with one — and no error is
raised, so the failure looks like a rendering bug in the game.

**The SDK attaches itself only to a development build.** A release build
carries no SDK unless a scene explicitly places one, and a game without the SDK
cannot be driven.
