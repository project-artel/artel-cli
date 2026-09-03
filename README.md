# artel

The command line interface for the ARTEL platform.

> Early work. The repository currently carries its agent instructions and
> nothing else; the commands below are the shape being built toward, not what
> ships today.

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
as often a program or a coding agent as it is a person.

## Two things worth knowing before automating a run

**Do not launch the game with `-batchmode`.** The SDK captures the screen by
reading the back buffer, and batchmode presents none. The capture comes back
blank — grey without a graphics device, black with one — and no error is
raised, so the failure looks like a rendering bug in the game.

**The SDK attaches itself only to a development build.** A release build
carries no SDK unless a scene explicitly places one, and a game without the SDK
cannot be driven.
