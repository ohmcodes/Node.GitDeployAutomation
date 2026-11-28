# Deployment and operations

## Security first

Git Deploy is a single-administrator tool. An authenticated session grants the ability to clone repositories, run restricted custom scripts in project containers, build arbitrary Dockerfiles and control the Docker daemon. The Docker socket and the default container's root user give effectively unrestricted access to the host. Only connect trusted repositories. Custom scripts are limited to `docker compose exec/run --rm/restart`, `echo` and `sleep`, run without a shell, but a repository's own Compose file and Dockerfiles still run with Docker access. A malicious repository or Compose file can compromise the host.

The HTTP server has no built-in TLS, user accounts, or audit trail. The supplied Compose configuration binds its port to host loopback only. Access it locally, through an SSH tunnel, or through a properly secured HTTPS reverse proxy/VPN with additional access controls and proxy-level rate limiting. Never publish the service port directly to the internet. Before authenticator enrollment, login uses the deployment token alone. After enrollment, login uses an authenticator code alone, without the token. **Both modes are single-factor authentication**, even though an authenticator app is commonly used as a second factor elsewhere. The server issues an eight-hour session stored in browser session storage. While signed in with the authenticator, sensitive actions ask only for confirmation; after 15 minutes without user activity (`IDLE_TIMEOUT_MINUTES`), or without any request because the tab was closed or hidden, the session ends and the next sign-in needs a new code. A code supplied with an action is still verified. Sessions are invalidated on restart, logout, enrollment, or authenticator reset. Five failed login attempts across the instance lock login for 15 minutes; the in-memory limit resets on restart and is not a substitute for proxy rate limiting. Protect the browser and deployment host.

Keep the deployment token and authenticator secret out of Git, logs and screenshots. Use a long randomly generated token. Rotate it by changing the value and restarting the service. The authenticator secret and replay counter are stored unencrypted in `DATA_DIR/auth.json` with owner-only permissions on supported Unix systems; protect the data directory and backups. Avoid proxy request-body logging. A TOTP code can be used only once across login and sensitive actions; wait for the next code between actions. The host clock must be synchronized.

Each manual deployment or redeployment, repository deletion, and container stop, kill, restart or pause requires an enrolled authenticator and a fresh code in addition to the signed-in session. These actions are blocked until enrollment. Failed action confirmations are limited across the instance to five attempts per 15 minutes; the in-memory limit resets on restart. A failed operation may consume its code. Automatic watcher deployments do not prompt and can restart containers. Starting or resuming containers, editing settings or environment files, and other administrative operations do not require a separate confirmation; protect the session as it still grants Docker host access even before enrollment.

State, scripts, Git URLs, and the most recent command output are stored in `DATA_DIR/state.json`; cloned source is under `DATA_DIR/repos`, and recent centralized activity is in `DATA_DIR/activity.json`. Managed Git tokens and unencrypted SSH private keys are stored in `DATA_DIR/credentials`, with owner-only permissions on supported Unix filesystems. They are not encrypted at rest; protect the data directory and backups and apply equivalent access controls on other platforms. Output may contain application secrets, including the last 100 log lines from each Compose service. Avoid logging credentials. URL-embedded HTTPS credentials are rejected. The dashboard token is not passed to deployment child processes.

## Docker installation

1. Install Docker Engine and the Compose plugin on the deployment machine. Clone this project there. Create a persistent directory:

   ```sh
   sudo mkdir -p /srv/git-deploy
   sudo chmod 700 /srv/git-deploy
   ```

2. Set a long random token in your shell (or place `DEPLOY_TOKEN=...` in an appropriately protected `.env` file next to `compose.yaml`; do not commit it):

   ```sh
   export DEPLOY_TOKEN="$(openssl rand -hex 32)"
   echo "$DEPLOY_TOKEN"
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 git-deploy
   ```

3. Configure the authenticator from an interactive terminal on the Docker host:

   ```sh
   docker compose exec git-deploy node auth-admin.js setup
   ```

   Scan the terminal QR code with your authenticator app, then enter its current code to confirm. The QR needs at least 106 terminal columns and 53 lines; if it wraps or cannot be scanned, widen the terminal and reduce its font size, or enter the displayed secret manually as a time-based six-digit SHA1 code. The QR code, secret and provisioning URI grant login access: do not copy them into logs, screenshots, or chat. The QR code is generated locally. Once confirmed, wait for the next code before logging in.

4. Open `http://127.0.0.1:3014` on that host and sign in with the authenticator code. Before enrollment, sign in with the deployment token instead; protected actions remain blocked until enrollment. From another machine, an SSH tunnel is one option: `ssh -L 3014:127.0.0.1:3014 user@your-docker-host`, then open `http://127.0.0.1:3014` locally.

## Login recovery

If you lose the deployment token, replace `DEPLOY_TOKEN` in the protected host environment or `.env` and recreate/restart the service. The new token is used for login only before authenticator enrollment; after enrollment, login uses the authenticator instead. If you lose the authenticator, host access is required to reset it; stop Git Deploy first so no login is in progress, then run the reset in an interactive one-off container:

```sh
docker compose stop git-deploy
docker compose run --rm --no-deps git-deploy node auth-admin.js reset
docker compose start git-deploy
```

Verify the new authenticator code before the reset is saved. Restart the service even if the reset fails. For a direct Node installation, stop the server, run `node --env-file=.env auth-admin.js reset` interactively, then start the server again. There are no recovery codes or remote reset; protect the deployment host and back up the authenticator configuration securely.

The container mounts `/var/run/docker.sock`, `/srv/git-deploy`, and the host `/proc` read-only at `/host/proc` for CPU and memory metrics. The **same absolute data path** must be mounted inside the container and exist on the Docker daemon host: Compose bind mounts in managed projects are resolved by the host daemon, not inside Git Deploy. If you change the data path, change both sides of the volume mount and `DATA_DIR` together. This setup assumes a local Docker daemon and a Linux host. The `/proc` mount reports the Linux Docker host (on Docker Desktop, generally its Linux VM), not necessarily the desktop OS. For a direct host installation, set `HOST_PROC_DIR=/proc` on Linux. Leave it unset for remote Docker daemons or when the path is not that daemon's host; the dashboard will show host metrics as unavailable rather than mislabeling another machine.

The process CPU figure is relative to one core; host CPU is sampled between refreshes. Container metrics use `docker compose ps` and `docker stats` for projects with a deployment attempt, including unsuccessful attempts that may have left containers running; stopped containers are not included. They are snapshots, not health checks. The centralized feed records the latest 200 output chunks, including entries from removed projects, and is not an audit log.

The dashboard links its Git Deploy process and Docker host summaries to the metrics page, which shows resource bars and individual managed-container statistics. Each repository card also displays its own running containers. Expand a container card to see details; the graph buttons control which CPU, memory, network and disk I/O graphs are displayed without stopping sampling. Repository, container and graph column controls change their layouts; narrow screens use fewer columns. Display preferences, including theme, accent, graph selection, columns, and expanded cards, are stored in browser local storage and persist across reloads and logouts. Metrics refresh every 15 seconds while the dashboard is open. Graphs retain up to 120 samples in the current browser session only; they are cleared on logout or reload. Network and block I/O totals come from Docker's cumulative counters; rate graphs estimate changes between samples and may be imprecise because Docker rounds those counters. No host-wide network or block I/O is collected. Process and container CPU percentages can exceed 100% because they are relative to one CPU core.

Expand a repository card and choose **More actions → Containers** to list the Compose project's containers, including stopped ones. It offers start, stop, kill, restart, pause, resume, logs, Docker inspection and container process lists. Inspection has a table view with expandable nested values and a raw JSON view; both show the full read-only inspection and can contain secrets. Each action requires confirmation and leaves the repository watcher unchanged: a later automatic deployment can restart stopped containers. Kill can abruptly terminate a service; pause freezes its processes. Inspection, logs, process lists and Compose configuration may contain secrets. Only the project's currently listed containers can be targeted; project names shared with other deployments may make those containers part of the same Compose project. Inspection shows restart policy, mounts and networks, but these settings are not edited here. Make durable changes in the Compose configuration; editing mounts may require recreation and backups.

To upgrade, back up the data directory, update the Git Deploy source, and rerun `docker compose up -d --build`. To stop Git Deploy, use `docker compose down` in this project's directory; this does not stop the separately deployed projects. To back up, stop Git Deploy and copy `/srv/git-deploy` securely; preserve the same path when restoring so project bind mounts continue to work.

## Private repositories

Public HTTPS URLs work without configuration. For private HTTPS, choose a managed token when adding the repository, providing a Git username and a narrowly scoped, read-only provider token. The token is supplied to Git through its environment, not the URL or command line; it is stored unencrypted and can be rotated in repository settings. Git providers differ in their accepted usernames and token permissions. Alternatively, use an existing noninteractive Git credential helper. Never put credentials in the URL or custom scripts.

For SSH, use a URL such as `ssh://git@github.com/owner/repository.git` (the `git@host:path` shorthand is not supported). The dashboard can generate a per-repository unencrypted Ed25519 key. Add the displayed public key as a read-only deploy key at your Git provider, then start the clone. Configure verified host keys for the operating-system user running Git Deploy **before** cloning, including when using generated keys. For the supplied container, mount a protected, preconfigured SSH directory read-only at `/root/.ssh` in a Compose override; make sure key permissions are acceptable to OpenSSH. Verify host key fingerprints independently; do not disable host key checking. Git runs noninteractively. A failed clone can be retried after correcting credentials or host keys; retry removes the failed clone directory. Removing a repository deletes its managed credentials but does not revoke them at the provider.

## Repository environment files

After a successful clone, expand the repository card and select **More actions → .env**, paste the complete root environment file (for example `DATABASE_URL=...`), and save it before selecting **Deploy**. The editor also loads an existing file for changes; saving replaces its contents. Changes do not restart containers automatically: deploy again to apply them. Compose reads the root `.env` for interpolation; the project must explicitly use `environment:` or `env_file:` to pass values into containers. Docker Compose's normal environment precedence applies.

The file is stored unencrypted in `DATA_DIR/repos/<repository-id>/.env`, with owner-only permissions on supported Unix filesystems. It is returned only through an authenticated API and is not included in repository state or activity entries, but scripts, Compose output and container logs can still disclose values. Protect the data directory, backups, browser session and transport. File content is limited to 64 KiB; symlinks and directories are rejected. Make sure `.env` is ignored in the repository to avoid later Git conflicts or accidental commits. The editor refuses to overwrite a Git-tracked `.env`; remove it from version control first and rotate any credentials already committed. Nested or differently named environment files must be managed separately. Removing the repository deletes its clone and its `.env`.

After a successful deployment, **Redeploy** performs a pull and `docker compose up -d --build --force-recreate`. This recreates all project services, potentially interrupting them; the watcher continues to use normal Compose behavior without forced recreation.

**View page** reads a literal `DOMAIN` from the repository root `.env`. A bare hostname defaults to HTTPS; specify `http://` explicitly when needed. Literal quoted values and a URL path are supported; interpolation, credentials, query strings, and fragments are not. When no domain is set, the dialog lists running Compose services' published TCP ports as HTTP links using the dashboard's hostname. Verify you select a web service; not every TCP port serves HTTP. Port bindings, firewalls, SSH tunnels, remote Docker daemons, and reverse proxies can make those links unreachable, and a loopback-only binding is accessible only from the Docker host. Configure `DOMAIN` when the publicly reachable address differs.

## File ownership for deployed containers

**Automatic permissions** (on by default, per repository in **Settings**) handles this for you. Before `docker compose up`, Git Deploy reads the resolved Compose configuration and, for every service with writable mounts (named volumes, and bind mounts inside the clone), runs `id` in a one-off container of that service to find its user. Unless that user is root, it then runs `chown -R` as root in another one-off container of the same service. That container gets back only the `CHOWN`, `FOWNER`, `DAC_OVERRIDE` and `DAC_READ_SEARCH` capabilities, so services hardened with `cap_drop: ALL` are handled too; the running service keeps its own settings. Because the change happens inside the app's own container, symlinks resolve inside the container, never on the host. It never touches read-only mounts, host paths outside the clone (such as `/var/run/docker.sock`), a mount of the whole repository, or folders holding Compose files or Dockerfiles; the Activity log names anything it skipped. Images without an `id` command (for example distroless) are reported, so set the manual owner below for them. A path that exists only inside the image (no volume) must be prepared in the Dockerfile, for example `RUN mkdir -p /data && chown node:node /data` before `USER node`.

The manual settings below remain under **Settings → Advanced** for cases automatic detection cannot handle.

Git Deploy runs as root in its container, so everything it clones is owned by root. A deployed app that runs as a non-root user (for example the `node` user, UID 1000) and bind-mounts a folder from the clone, such as `./data:/data`, then fails to write to it with `EACCES: permission denied`.

In the repository's settings, set **File owner** (`UID:GID`, for example `1000:1000`) and **Writable folders** (for example `data, storage/uploads`). Before each `docker compose up`, Git Deploy creates any listed folder that is missing and gives it, with everything inside, to that owner. A saved `.env` is also given to the owner straight away and keeps its owner-only `0600` permissions. Find the right IDs with `docker compose exec <service> id`. Changing either setting asks for confirmation.

Safety rules:
- Only the listed folders are changed, never the clone root, `.git`, or the rest of the repository. Paths must be relative and cannot contain `..`.
- The deployment stops if a listed folder contains a tracked Compose file, Dockerfile or `.dockerignore`, since a compromised app could otherwise rewrite the next root-run deployment. List data folders only.
- Symlinks are never followed: a listed folder that is a symlink is refused, and symlinks inside are re-owned themselves without touching their targets.
- Ownership changes need Git Deploy to run as root on Linux, as the supplied container does; elsewhere they are skipped.

A named volume (`app-data:/data`) does not need this setting; Docker initializes it from the ownership in the image.

## Container consoles

**Containers → Console** (or **Root console**) opens an interactive shell in a running container of the project, in the browser. It runs `bash`, or `sh` when the image has no bash, as the container's configured user, or as root (UID 0) for **Root console**. Opening one asks for confirmation. The browser then receives a single-use ticket that expires after 30 seconds and opens a WebSocket at `/api/console` on the same origin. Opening and closing a console is recorded in the repository's activity, but what you type is not.

A console closes when the shell exits, after 30 minutes without input, or when the session ends (sign-out, expiry, restart or authenticator reset). At most 10 consoles can be open at once. Changes made in a console affect only the live container; the next deployment can recreate it and discard them.

Consoles talk to the Docker Engine API directly. They work with the default local socket (`/var/run/docker.sock`, mounted by the supplied Compose file), `DOCKER_HOST=unix://…`, a Windows named pipe, or plain `tcp://`. They do not work with TLS (`DOCKER_TLS_VERIFY`) or `ssh://` Docker hosts. If you put a reverse proxy in front of Git Deploy, it must forward WebSocket upgrades for `/api/console` and pass the original `Host` header (for nginx, `proxy_set_header Host $host;`), because the console checks that the browser's `Origin` matches it. Shells are ended (Ctrl+C, then `exit`) when a console closes, but a process that ignores this can keep running in the container until it restarts.

## Removing projects

Removal always deletes the managed clone and credentials. Select the optional cleanup boxes to run `docker compose down`, and optionally `--rmi local` to remove images without custom tags. Compose project names may be shared with other deployments, and images may be used elsewhere; review the target carefully and back up first. Named and anonymous volumes are not removed. If Compose cleanup fails, the repository is retained and its error appears in Activity; cleanup may already have partially completed.

## Troubleshooting

- **Cannot start:** `DEPLOY_TOKEN` must be at least 16 characters, and the poll interval must be an integer of 10 or more.
- **Clone fails:** open the card's **Activity** log for the Git error; check URL, branch, network, and noninteractive credentials. Remove the failed entry and add it again.
- **Deploy fails:** open the card's **Activity** log for Git, Compose, or script output. A script rejected as unsafe names the line to fix in **Settings**. Verify the Compose file, Docker access, project environment files and port availability. Fix the issue and select **Deploy** again.
- **Watching stops:** any failed check or deployment requires a successful manual deploy to resume polling. If the branch was force-pushed, resolve the checkout manually rather than automatically discarding local changes.
- **Unexpected service state:** `docker compose ps` and logs are snapshots taken during deployment, not continuous health checks. Inspect the managed project with Docker directly.
