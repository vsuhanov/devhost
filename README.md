# devhost

HTTPS hostnames for whatever you're running locally, one set per git worktree, with no changes to your apps.

```
https://main.myapp.test           ← main checkout's web app
https://api.main.myapp.test       ← main checkout's API
https://feature-x.myapp.test      ← the same app, running from the myapp-feature-x worktree
https://myapp.test                ← picker: every running instance of myapp
https://devhost.test              ← picker: everything
```

You start your app however you normally do. devhost looks at which processes are listening, works out which app and worktree each one belongs to from its working directory, and writes Caddy routes for them. When the app stops, its routes go away. The app is never told about devhost: no env vars, no hooks, no config in the repo.

## Why

If you run several worktrees of the same app at once, every copy fights over the same ports and you end up juggling `localhost:3000`, `:3002`, `:5174`... and losing track of which is which. Real hostnames over HTTPS also make cookies, OAuth redirects, CORS and service workers behave like production.

## How it works

```
browser → feature-x.myapp.test → dnsmasq (*.test → 127.0.0.1) → Caddy :443 → localhost:5174
```

1. `lsof` lists listening TCP sockets, with each process's PID, working directory and command line.
2. A process belongs to an app when its working directory is inside a folder matching that app's `match` patterns. That folder is the instance (a worktree, say).
3. Each route rule picks a process in that instance by a substring of its command line, such as `vite` or `src/api/main.ts`.
4. devhost writes the routes to a Caddyfile snippet and runs `caddy reload`, but only if something changed. If the reload fails, it puts the previous snippet back.

Ports can be anything and change on every start. Rules match commands, not ports.

## Requirements

- macOS (uses `lsof`, Homebrew paths, `/etc/resolver`). Linux should mostly work with `DEVHOST_CADDYFILE` set and your own wildcard DNS, but is untested.
- Node.js 24 or newer (runs the TypeScript sources directly; no build step, no runtime dependencies).
- Caddy, and wildcard DNS for `*.test`. Setup below.

## Setup

### 1. Wildcard DNS for `.test`

`/etc/hosts` has no wildcards, so use dnsmasq, and tell macOS to ask it for `.test` names only:

```sh
brew install dnsmasq
cat >> "$(brew --prefix)/etc/dnsmasq.conf" <<'EOF'

address=/.test/127.0.0.1
address=/.test/::1
listen-address=127.0.0.1
bind-interfaces
EOF
sudo brew services start dnsmasq

sudo mkdir -p /etc/resolver
echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/test
```

Check with `dscacheutil -q host -a name anything.test`. Don't use `dig` or `nslookup`; they bypass the macOS resolver and give misleading answers.

`.test` is reserved (RFC 2606) and never resolves publicly. Avoid `.local` (mDNS, ~5s delays) and `.dev` (a real TLD with HSTS preload).

### 2. Caddy with local certificates

```sh
brew install caddy
mkdir -p "$(brew --prefix)/etc/caddy.d"
cat > "$(brew --prefix)/etc/Caddyfile" <<EOF
{
	local_certs
}

import $(brew --prefix)/etc/caddy.d/*.caddy
EOF
brew services start caddy
caddy trust
```

- `local_certs` is required. Without it, Caddy asks Let's Encrypt for `.test` certificates and gets refused.
- Run `caddy trust` after the service starts. The Homebrew service keeps its CA in `$(brew --prefix)/var/lib/caddy`, and `caddy trust` fetches the root from the running instance, so the CA you trust is the one actually signing certificates.

### 3. devhost

```sh
git clone https://github.com/vsuhanov/devhost.git ~/projects/devhost
ln -s ~/projects/devhost/bin/devhost ~/.local/bin/devhost   # any directory on your PATH
```

## Configure an app

One JSON file per app in `~/.config/devhost/apps/`. The file name is the app name.

`~/.config/devhost/apps/myapp.json`:

```json
{
  "domain": "myapp.test",
  "match": [
    "~/projects/myapp",
    "~/projects/myapp-*"
  ],
  "routes": [
    { "command": "vite", "host": "{instance}", "hostHeader": "upstream" },
    { "command": "src/api/main.ts", "host": "api.{instance}" }
  ]
}
```

| Field | Meaning |
|---|---|
| `domain` | Base domain. Defaults to `<app>.test`. It also serves the app's picker page. |
| `match` | Instance root folders. `~` is expanded, and `*` matches within one path segment. |
| `routes[].command` | Substring of the listening process's command line (`ps -ww -o command=`). |
| `routes[].host` | Subdomain under `domain`. `{instance}` is replaced with the instance name. |
| `routes[].hostHeader` | `"upstream"` sends `Host: localhost:<port>` upstream, for dev servers that reject unknown hosts (Vite does). `X-Forwarded-Host` still has the real name. |

Rules are applied in order. Each one takes the lowest listening port from a matching process in the instance, and each process is used at most once. The first route is where the picker links to.

**Instance names:** `main` for the main checkout of a repository. For linked worktrees it's the folder name with the main folder's name as a prefix removed: `~/projects/myapp-feature-x` becomes `feature-x`. Outside git, it's the folder name.

## Usage

```sh
devhost up       # sync, then print the URLs for the worktree you're in
devhost ls       # sync, then list all routes
devhost watch    # sync every 3 seconds (--interval <seconds>)
devhost paths    # where config, state and the generated Caddyfile live
```

Every command syncs first, so whatever you run, the routes match what's running at that moment. Without `watch`, a stopped app's routes stay until the next devhost command.

### Things that aren't discovered

For Docker containers, or anything else whose process doesn't run from the project folder, add a route by hand:

```sh
devhost add blog/main 8080                     # → https://main.blog.test
devhost add blog/main 8080 --host 'admin'      # → https://admin.blog.test
devhost rm blog/main
```

Hand-made routes stay until you remove them and show as down while nothing listens on the port.

### Keep `watch` running

To have instances show up without running anything, run `devhost watch` from a launchd agent, or just leave it in a terminal tab.

## Wiring services together without devhost

devhost tells apps nothing, which raises a question: how does the UI on `feature-x.myapp.test` find its API? The answer is to avoid needing to:

- **One hostname per instance for everything the browser talks to.** Let the frontend dev server proxy API paths (Vite's `server.proxy`, for example). The UI calls `/api/...` relative to the page, there's no CORS, and nothing needs to know any hostname.
- **Get the public URL from the request.** Caddy sends `X-Forwarded-Host` and `X-Forwarded-Proto`. An app that trusts them (most frameworks have a "trust proxy" setting) builds correct absolute URLs behind any proxy, including in production.
- **Keep cookies host-only.** A cookie with `Domain=.myapp.test` is shared between all instances.

## Files

| Path | What |
|---|---|
| `~/.config/devhost/apps/*.json` | App configs (`$XDG_CONFIG_HOME` is respected) |
| `~/.local/state/devhost/manual.json` | Hand-made routes (`$XDG_STATE_HOME` is respected) |
| `~/.local/state/devhost/site/` | The picker page and `instances.json`, served by Caddy |
| `$(brew --prefix)/etc/caddy.d/devhost.caddy` | Generated routes. devhost owns this file; don't edit it. |

The Caddyfile is found at `/opt/homebrew/etc/Caddyfile` or `/usr/local/etc/Caddyfile`. Set `DEVHOST_CADDYFILE` to use another, and the snippet goes in `caddy.d/` next to it.

Keep your own routes in the main Caddyfile, but don't define sites there for a configured app's `domain` or `devhost.test`. Caddy rejects duplicate sites, and devhost will report the failed reload.

## Uninstall

```sh
rm ~/.local/bin/devhost
rm -rf ~/.config/devhost ~/.local/state/devhost "$(brew --prefix)/etc/caddy.d/devhost.caddy"
caddy reload --config "$(brew --prefix)/etc/Caddyfile"
```

## License

MIT
