# Pending — to review later

Notes from the session that added container consoles, the Pull button, file ownership, safe custom scripts and the inline live activity log (see `CHANGELOG.md`, Unreleased).

## Next steps on the server

1. **Rebuild Git Deploy** (new packages: `ws`, `@xterm/xterm`, `@xterm/addon-fit`):
   `git pull`, then `docker compose up -d --build` in the Git Deploy folder.
2. **Fix existing custom scripts.** Scripts that don't fit the safe list now **fail their deployment**. In each repository's **Settings**, rewrite them. For example, `npm run migrate` becomes `docker compose exec app npm run migrate`. Saving a script asks for confirmation. Allowed, one per line:
   ```
   docker compose exec <service> <command>
   docker compose run --rm <service> <command>
   docker compose restart [service...]
   echo <text>
   sleep <1-300>
   ```
   No pipes, `&&`, `;`, `$VARS` or redirects. Put complex steps in a script file in the image and call it with `docker compose exec app sh ./scripts/x.sh`.
3. **Fix the `/data/secrets.json` EACCES error:** **Automatic permissions** is on by default, so just **Redeploy**. Then read the Activity log for lines starting with `Automatic permissions:`:
   - `/data in app now owned by 1000:1000`: fixed.
   - `no writable mounts to prepare`: `/data` is not a volume or bind mount. Either add one in the app's compose file (`volumes: [app-data:/data]`) or prepare it in the Dockerfile (`RUN mkdir -p /data && chown node:node /data` before `USER node`).
   - `could not detect the user`: the image has no `id` command. Use **Settings → Advanced** (File owner + Writable folders).
   - `… left unchanged`: the log says why (whole-repo mount, or a folder with Compose files or Dockerfiles).
4. **Reverse proxy** (if used). Consoles need WebSockets and the original Host:
   ```nginx
   proxy_set_header Host $host;
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```
5. **Run the Linux-only ownership test** (skipped on Windows; it has never run). From the Git Deploy folder:
   ```sh
   docker run --rm -v "$PWD":/app -w /app node:lts-alpine node --test test/file-owner.test.js
   ```
   Expect 6 passing tests and none skipped.
6. **Try one console** on the real server. Tests only used a fake Docker.

## Open decisions

- **Idle sign-out time:** 15 minutes by default (`IDLE_TIMEOUT_MINUTES`). Adjust if it is too short or too long.
- **Code-free actions vs. a stolen session:** after the authenticator sign-in, actions need only a confirmation. Someone who steals the session token (for example through XSS or a shared machine) can skip the browser's idle report and keep it alive for the full 8 hours with deploy, delete and root-console rights. Option ("sudo mode"): allow code-free actions only for a fixed time after the last real code (for example 60 minutes), then ask for a code once.
- **`COMPOSE_*` keys in the `.env` editor:** a repo's `.env` can set `COMPOSE_PROJECT_NAME` to *another* repo's project. That repo's script could then act on the other project's service with the same name. Git Deploy's own project is already protected. Options: block `COMPOSE_*` keys in the editor (some people set the project name there on purpose), or require an authenticator code for `.env` edits.

## Known limitations (accepted for now)

- Automatic permissions runs `chown -R` over each writable volume on every deploy, including watcher deploys. Large media volumes make deploys slower and change file timestamps (ctime) for backup tools. Possible improvement: only change files not already owned by the service user.
- Automatic permissions checks that a bind-mounted folder is not a symlink just before the deploy. A compromised app could swap one in during the seconds between that check and the mount.

- Console tickets travel in the WebSocket URL, so a proxy access log could record one. They are single-use and expire in 30 seconds.
- Consoles do not work with TLS (`DOCKER_TLS_VERIFY`) or `ssh://` Docker hosts.
- Closing a console sends Ctrl+C and `exit`. A process that ignores both keeps running until the container restarts.
- Script safety relies on Docker Compose treating everything after the service name as the command to run, not as options of its own. Current versions do this.
- When a log reaches the 40,000-character cap, a reader scrolled up may see the text shift.
- Missing docs required by `CLAUDE.md`: `FEATURES.md`, developer docs and end-user docs.
