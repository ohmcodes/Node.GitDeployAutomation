# Changelog

## Unreleased

### Fixed
- **Automatic permissions did nothing for hardened services** (`cap_drop: ALL`, as in CronDNS): the one-off `chown` container inherited the dropped capabilities, so even root could not change owners, and the app still failed with `EACCES` (for example on `/data/secrets.json`). The `chown` container now adds back only `CHOWN`, `FOWNER`, `DAC_OVERRIDE` and `DAC_READ_SEARCH` for that single command; the service itself is unchanged.
- Writable bind mounts from host paths outside the repository are now named in the Activity log instead of being skipped silently.

### Added
- **Automatic permissions** (default on): before each deploy, writable mounts (named volumes, bind mounts inside the clone) of every non-root service are given to the user that service runs as, using one-off containers of that service. Manual File owner moved to Settings → Advanced.
- **.env field** when adding a repository, saved as soon as the clone exists.
- **Containers** button on the card itself, available even after a failed deploy.
- Card log **Clear** and **Auto-scroll** controls; "More actions" is now a dropdown menu.
- `IDLE_TIMEOUT_MINUTES` (default 15).
- Collapsible **Activity** log inside each repository card, replacing the popup. It opens by itself when an operation starts (the card expands for your own Deploy, Pull or clone), streams command output live, and keeps your scroll position. The dashboard polls every second while something runs.
- **Pull** button on repository cards: runs `git pull --ff-only` without rebuilding or restarting containers. A watched, deployed repository deploys the pulled commit on its next check.
- **Console** and **Root console** for running containers: an in-browser terminal (xterm.js) running bash or sh, over a WebSocket opened with a single-use ticket after a fresh authenticator code.
- Per-repository **File owner** (`UID:GID`) and **Writable folders**: before each `docker compose up`, the listed folders are created if missing and given to the deployed containers' user (symlink-safe; refuses folders holding Compose files or Dockerfiles). Fixes `EACCES` when apps write into bind-mounted folders. Changing it needs a fresh authenticator code.
- Project `CLAUDE.md` with Node.js project conventions.

### Changed
- **Sign-in and confirmations:** after signing in with the authenticator, sensitive actions ask only "Are you sure?" (no code). After 15 minutes without activity, or with the tab hidden or closed, the session ends and the next sign-in needs a new code. Codes sent with actions are still verified.
- **Custom scripts are restricted to safe commands**: `docker compose exec <service> …`, `docker compose run --rm <service> …`, `docker compose restart [service…]`, `echo`, `sleep`. They run without a shell inside the project's containers, never in Git Deploy. Unsafe scripts are rejected on save; previously saved ones fail the deployment with the line to fix. Changing a script needs a fresh authenticator code. A script is refused if the Compose project resolves to Git Deploy's own (for example via `COMPOSE_PROJECT_NAME` in `.env`). Commands get no stdin, and a script stops after 60 minutes.
- The Content Security Policy allows inline styles (`style-src 'unsafe-inline'`), which the terminal emulator needs. Scripts are still restricted to the same origin.
- New dependencies: `ws`, `@xterm/xterm`, `@xterm/addon-fit`.
