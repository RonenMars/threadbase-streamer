# Cloudflare onboarding TUI

A small [Bubble Tea](https://github.com/charmbracelet/bubbletea) wrapper around `../cloudflare.sh` / `../cloudflare.ps1`. Renders stepwise progress for the Cloudflare quick-tunnel onboarding flow.

The underlying shell scripts work fine on their own — this TUI is opt-in polish for terminals where you'd rather see a clean progress UI than scrolling lines.

## Run it

```sh
cd scripts/remote-access/tui
go run .

# Force the bash script (default on Unix)
go run . --shell bash

# Force the pwsh script (default on Windows)
go run . --shell pwsh
```

You can also build a binary and stash it somewhere:

```sh
go build -o cloudflare-tui .
./cloudflare-tui
```

## How it works

The TUI execs the right script as a subprocess, captures its stdout, and parses the line-prefixed protocol both scripts emit:

```
STATUS: starting cloudflared quick-tunnel
URL: https://abc-def-ghi.trycloudflare.com
PROMPT: Did the success page load on your phone? [y/N]
DONE: ok
```

Each line drives a `tea.Msg` into the Bubble Tea model. The TUI writes the user's `y`/`n` answer back to the script's stdin, then waits for the `DONE:` line and exits.

Ctrl-C in the TUI sends `SIGINT` to the script, which trips its cleanup trap — so the tunnel and the success-page server always tear down even if you bail mid-flow.
