# artel

The command line interface for the ARTEL platform. It runs a QA agent against a
game from a terminal or from CI, without opening the console in a browser.

## Installing

The CLI is published on npm as `@project-artel/cli`, and the command it installs
is `artel`. It needs Node.js 22.12.0 or newer.

```
npm install -g @project-artel/cli@alpha
artel --version
```

Keep the `@alpha` tag. Releases go out under the `alpha` dist-tag, and `latest`
still points at the older `0.0.1-alpha.0`.

To run it without a global install, as in CI, use `npx`:

```
npx @project-artel/cli@alpha <command>
```

To let an AI coding agent such as Claude Code, Codex or Cursor install it, give
the agent this prompt. [`https://artel.kr/cli.md`](https://artel.kr/cli.md)
holds step-by-step instructions written for the agent.

```
Install the ARTEL CLI on this machine by following https://artel.kr/cli.md
```

## Commands

```
artel auth login                                        # this machine's credential
artel project list                                      # ids the other commands take
artel doc upload --project <id> design.pdf              # the plan the agent reads
artel case create --project <id> --file cases.json      # what the agent should check
artel scenario create --project <id> --steps steps.json # how it should check it
artel run create --project <id> --name smoke            # a set of scenarios
artel run scenarios <run id> --project <id> --set <ids> # fill that set
artel game start --build ./Build/Game.exe --project <id>
artel game list --project <id>                          # ids qa run takes
artel qa run --test-run <id> --instance <id>            # start one, watch to a verdict
artel qa matrix --test-run 1,2 --slot ... --slot ...    # many, spread over builds
artel qa watch <run id>
artel qa show <run id>
artel qa list --project <id>                            # find a run you lost
artel qa diff <config> <config>                         # two configurations, compared
artel issue list --project <id>                         # what the runs found
artel map show --project <id> --build <id>              # what the agent could read
artel game logout --build ./Build/Game.exe --project <id>
```

`artel <group> --help` lists the rest of each group. Every command that reports
a result also takes `--json`. In that output a key never disappears, and an
unknown value is `null`.

## Authenticating

The CLI takes a credential from one of two places, and the first one wins.

**`ARTEL_TOKEN`.** Set it to a CLI token issued in the console's account
settings. Use this in CI: it needs no file and no browser. An empty value counts
as unset.

**`artel auth login`.** It opens the console in a browser and stores the issued
token at `~/.artel/credentials.json` (`%USERPROFILE%\.artel\credentials.json` on
Windows). Set `ARTEL_CONFIG_DIR` to keep that file somewhere else.

By default the CLI talks to the stage deployment: the API at
`https://stage-orch.artel.kr` and the console at `https://home.stage.artel.kr`.
Point it elsewhere with `ARTEL_API_BASE_URL` (or `--api-url`) and
`ARTEL_CONSOLE_BASE_URL` (or `--console-url`). The addresses `artel auth login`
used are stored with the credential and become the default for later commands.
An API with no known console, such as `http://localhost:8080`, needs
`--console-url` too.

`artel auth status` says which credential is in use and where it came from. It
prints a fingerprint, never the token.

`artel auth logout` deletes the local file. It does not revoke the token on the
server; revoke it in the console.

## Finding project and instance ids

**`artel project list`** lists the projects this credential can see. The output
is paged; it says which `--page` holds the rest.

**`artel game list --project <id>`** lists that project's game instances and
whether each one is connected now. An instance appears only after a build with
the SDK has registered once, so an empty list usually means `artel game start`
has not run yet.

## Launching a game

**`artel game start --build <path> --project <id>`** launches the build already
signed in, waits until it registers with the server, prints the game instance
id and exits. The game keeps running. The id is what `artel qa run --instance`
takes.

- The game launches windowed. `--width` and `--height` set the window size, and
  `--fullscreen` launches it full screen.
- The game log goes to a new file under `~/.artel/logs`.
- If the build does not register within `--timeout` seconds (default 60), or
  exits first, the error says which and names the log file.

**`artel game logout --build <path> --project <id>`** launches the build once to
clear its stored session, and waits for it to exit (`--timeout`, default 30).

## Running QA

**`artel qa run --test-run <id> --instance <id>`** starts a QA run and follows
it until the agent reaches a verdict. `--no-wait` returns right after starting.

These flags set the run's configuration. A flag you leave out is chosen by the
server, and the result shows what it chose.

| Flag | Value |
| --- | --- |
| `--model` | model id; `artel qa models` lists them |
| `--prompt-version` | prompt version |
| `--reasoning-effort` | reasoning effort for the model |
| `--arch` | agent structure as a JSON object, or `@path` to a file holding one |
| `--content-map-mode` | `on`, `frozen` or `off` |
| `--knowledge-mode` | `learning`, `frozen` or `off` |
| `--label` | the experiment name |

**The exit code is the verdict.** `0` only when the run passed. Failed,
cancelled and unknown are all `1`. A run whose connection died before a summary
is unknown, so it never passes CI by accident. `artel qa watch` follows a run
already going and uses the same rule. `artel qa show` reads a run and always
exits `0`.

With `--json`, a following command prints the final result on stdout as one line
and the progress on stderr as one JSON object per line.

If the event stream drops, the CLI reconnects up to five times without losing
events. If it still cannot reconnect, it checks the run once more: a finished
run is reported normally, and a run still going fails with
`qa_watch_disconnected` while the run continues on the server. `--timeout
<seconds>` caps the whole wait (default one hour, `0` for no cap).

**`artel qa cancel <run id>`** stops a run and frees its game instance.

**`artel qa diff <base> <target>`** compares two configurations. Each side
selects runs by `model`, `promptVersion`, `reasoningEffort` and `arch`:

```
artel qa diff \
  'model=openai/gpt-5.6-luna,promptVersion=v15' \
  'model=openai/gpt-5.6-luna,promptVersion=v16' --project <id>
```

A field you leave out matches every value, and the matching runs are added
together. Every rate in the table shows its denominator.

## Running a matrix of configurations

**`artel qa matrix`** runs every combination of the values you list, spread over
several game builds:

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

That is 2 test runs × 2 content map modes = 4 runs over 2 slots.

- Comma-separated values multiply the runs. A flag with one value applies to
  every run. Pass `--model` even when you are not comparing models, so the
  server cannot pick different models within one matrix.
- `--arch` is repeated instead of comma-separated, and each value needs its own
  `"label"` field.
- `--reasoning-max-tokens` applies to every run.
- `--repeat n` runs each combination n times, because one run per combination
  cannot separate the configuration from chance.
- Each `--slot` runs one QA run at a time, and the game is relaunched for every
  run.
- **Each slot needs its own build with a different `productName`.** Two builds
  with the same `productName` register as one game instance and overwrite each
  other's saves.
- `--out <path>` writes each finished run to a file as it finishes, one JSON
  object per line. `--resume` skips the runs already in that file and runs the
  rest.
- A failed combination does not stop the others. The exit code is `0` only when
  every combination passed.

## Reading the content map

**`artel map show --project <id> --build <id>`** shows what the content map of a
build holds: scenes, scene edges, screen transitions, spec gaps, confirmed
`evidence` features, and the last scan. It says whether the build has no
`evidence` document at all or has one that is not ingested yet.

`artel doc scan` starts a scan. `--watch` follows a scan before reading, capped
by `--timeout`.

## Reading what a run found

`artel issue` handles the defects QA runs found. These are not Jira issues.

**`artel issue list --project <id>`** lists them newest first, with the run each
came from. `--status` and `--severity` filter them. When there are more, the
output prints the `--before` cursor for the next page.

**`artel issue resolve <id>`** and **`artel issue reopen <id>`** change an
issue's status.

## Before automating a run

**Do not launch the game with `-batchmode`.** The SDK captures the screen from
the back buffer, and batchmode has none. The screen capture comes back blank
with no error.

**The SDK attaches itself only to a development build.** A release build has no
SDK unless a scene places one, and a game without the SDK cannot be driven.
