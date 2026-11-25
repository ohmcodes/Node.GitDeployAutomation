# Git Deploy

A lightweight, self-hosted Git watcher and Docker Compose deployment dashboard. Add a repository, clone a branch, and deploy it manually once; Git Deploy then polls that branch and redeploys when it advances.

> **Administrator access only.** Anyone with the deployment token can run arbitrary shell commands and control Docker on the host. Docker socket access is effectively host-root access. Do not expose this service directly to the internet or use it for untrusted users, repositories, or scripts. See [deployment and security](DEPLOYMENT.md) before installing.

## What it does

- Dark-mode dashboard with repository, watching, deployed and error views.
- Clone HTTPS or `ssh://` repositories, select a branch (default `main`), and manually deploy.
- For a deployment, run `git pull --ff-only origin <branch>`, `docker compose up -d --build`, an optional custom shell script, `docker compose ps`, and `docker compose logs --tail=100` (all services).
- Poll deployed repositories for changes, deploy fast-forward updates, and pause or resume watching. A repository is not automatically deployed until its first manual deployment succeeds.
- Show the latest output, last successful commit and deployment time in the API, and persist state across restarts.
- Remove a repository and its clone without stopping its containers.

## Quick start

Requirements: Node.js 20+, Git, Docker with the Compose plugin, and permissions to use the Docker daemon. On the machine where the containers should run:

```sh
export DEPLOY_TOKEN="$(openssl rand -hex 32)"
echo "$DEPLOY_TOKEN"  # Enter this in the dashboard; keep it private.
npm start
```

Open <http://127.0.0.1:3000>, enter the token, and select **Add repository**. Supply the clone URL and branch, optionally add a shell script, and wait for cloning to finish. Select **Deploy** to perform the first deployment; use **Activity** to inspect output. Thereafter the watcher checks for changes every 60 seconds by default.

For running the application itself in Docker, private repositories, configuration, troubleshooting, and security details, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `DEPLOY_TOKEN` | required | Shared administrator token, at least 16 characters; use a long random value. |
| `HOST` | `127.0.0.1` | HTTP listen address. The supplied container sets this to `0.0.0.0`. |
| `PORT` | `3000` | HTTP listen port. |
| `DATA_DIR` | `./data` | Persistent state and repository clones. |
| `POLL_INTERVAL_SECONDS` | `60` | Poll interval, integer of at least 10 seconds. |

Run the focused tests with `npm test`. They use temporary Git and Docker stand-ins and do not deploy containers.

## Behavior and limitations

- One operation per repository runs at a time; different repositories can deploy concurrently. Run only one Git Deploy instance against a data directory.
- Failed clones can be removed and re-added. A failed check or deployment stops automatic checks for that repository; inspect **Activity**, fix the cause, and deploy manually to resume. Interrupted operations are marked as errors on restart. A non-fast-forward remote change requires manual resolution.
- The custom script runs via `sh -c` in the clone directory, **after** Compose starts. It runs in the Git Deploy container when installed with Docker, not directly on the host, so only tools installed in that runtime are available. A failure marks the deployment as failed, but does not roll back containers. Commands have a 15-minute timeout. Project Compose files must be in the repository root.
- The deployed count means a deployment previously succeeded, not that containers are currently healthy. This is not a full container management system or a substitute for backups and monitoring.
- Output is capped to the most recent 40,000 characters per repository and persisted on disk. Logs and scripts may contain sensitive information; do not print secrets. There is no secret manager, multi-user access control, audit log, deployment queue, rollback, webhook, or container health monitoring yet.

## Suggested next steps

Consider backups and a recovery plan, off-host health monitoring and notifications, deployment approvals, per-user permissions and an audit log, secret management, and rollback/version selection before relying on this for critical workloads. Webhooks could replace polling where network and authentication requirements permit.
