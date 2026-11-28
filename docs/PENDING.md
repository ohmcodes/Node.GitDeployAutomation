# Pending — to review later

Notes from the session that added container consoles, the Pull button, file ownership, safe custom scripts and the inline live activity log (see `CHANGELOG.md`, Unreleased).

## Next steps on the server

1. **Rebuild Git Deploy** (new packages: `ws`, `@xterm/xterm`, `@xterm/addon-fit`):
   `git pull`, then `docker compose up -d --build` in the Git Deploy folder.
2. **Fix existing custom scripts.** Scripts that don't fit the safe list now **fail their deployment**. In each repository's **Settings**, rewrite them. For example, `npm run migrate` becomes `docker compose exec app npm run migrate`. Saving a script now asks for an authenticator code. Allowed, one per line:
   ```
   docker compose exec <service> <command>
   docker compose run --rm <service> <command>
   docker compose restart [service...]
   echo <text>
   sleep <1-300>
   ```
   No pipes, `&&`, `;`, `$VARS` or redirects. Put complex steps in a script file in the image and call it with `docker compose exec app sh ./scripts/x.sh`.
3. **Fix the `/data/secrets.json` EACCES error:**
   1. **Containers → Console** on the app, run `id` (for example `uid=1000 gid=1000`).
   2. **Settings**: File owner `1000:1000`, Writable folders `data`, then enter the authenticator code.
   3. **Redeploy** and check the Activity log for a line starting with `File owner 1000:1000:`.
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

- **Automatic permissions per repo:** should Git Deploy read each repo's compose file (`docker compose config`), find each service's user and its bind mounts and named volumes, and fix ownership automatically on every deploy? If yes, should it be on by default with a per-repo switch? For now, File owner plus Writable folders covers this manually.
- **`COMPOSE_*` keys in the `.env` editor:** a repo's `.env` can set `COMPOSE_PROJECT_NAME` to *another* repo's project. That repo's script could then act on the other project's service with the same name. Git Deploy's own project is already protected. Options: block `COMPOSE_*` keys in the editor (some people set the project name there on purpose), or require an authenticator code for `.env` edits.

## Known limitations (accepted for now)

- Console tickets travel in the WebSocket URL, so a proxy access log could record one. They are single-use and expire in 30 seconds.
- Consoles do not work with TLS (`DOCKER_TLS_VERIFY`) or `ssh://` Docker hosts.
- Closing a console sends Ctrl+C and `exit`. A process that ignores both keeps running until the container restarts.
- Script safety relies on Docker Compose treating everything after the service name as the command to run, not as options of its own. Current versions do this.
- When a log reaches the 40,000-character cap, a reader scrolled up may see the text shift.
- Missing docs required by `CLAUDE.md`: `FEATURES.md`, developer docs and end-user docs.
