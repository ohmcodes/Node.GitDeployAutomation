# Git Deploy

A lightweight, self-hosted Git watcher and Docker Compose deployment dashboard. Add a repository, clone a branch, and deploy it manually once; Git Deploy then polls that branch and redeploys when it advances.

> **Administrator access only.** Anyone with the deployment token can run arbitrary shell commands and control Docker on the host. Docker socket access is effectively host-root access. Do not expose this service directly to the internet or use it for untrusted users, repositories, or scripts. See [deployment and security](DEPLOYMENT.md) before installing.

## What it does

- Light and dark themes, repository filters and status colors, a developer guide, and a centralized activity feed.
- Clone HTTPS or `ssh://` repositories, select a branch (default `main`), and manually deploy.
- For a deployment, run `git pull --ff-only origin <branch>`, `docker compose up -d --build`, an optional custom shell script, `docker compose ps`, and `docker compose logs --tail=100` (all services).
- After the first successful deployment, **Redeploy** additionally passes `--force-recreate`; automatic updates retain the normal Compose behavior.
- **View page** opens a chooser using the repository `.env` `DOMAIN`, or its published TCP ports if no domain is set.
- Poll deployed repositories for changes, deploy fast-forward updates, and pause or resume watching. A repository is not automatically deployed until its first manual deployment succeeds.
- Show Git Deploy process and configured Docker host summaries on the dashboard, per-container summaries on repository cards, and detailed bars for all three on the metrics page; persist deployment state and recent activity across restarts.
- Use a managed HTTPS token or generate an SSH deploy key for a private repository.
- Edit a repository's root `.env` after cloning, before or between deployments.
- Remove a repository and its clone, with optional Compose service and locally built image cleanup.

## Quick start

Requirements: Node.js 20.6+, Git, Docker with the Compose plugin, and permissions to use the Docker daemon. Set `DEPLOY_TOKEN` in `.env` (or in the shell environment) on the machine where the containers should run, then start the app:

```sh
npm start
```

Open <http://127.0.0.1:3000>, enter the token, and select **Add repository**. Supply the clone URL and branch, optionally add a shell script, and wait for cloning to finish. If needed, select **.env** on the repository card and save the project's environment file. Select **Deploy** to perform the first deployment; use **Activity** to inspect output. Thereafter the watcher checks for changes every 60 seconds by default.

For running the application itself in Docker, private repositories, configuration, troubleshooting, and security details, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `DEPLOY_TOKEN` | required | Shared administrator token, at least 16 characters; use a long random value. |
| `HOST` | `127.0.0.1` | HTTP listen address. The supplied container sets this to `0.0.0.0`. |
| `PORT` | `3000` | HTTP listen port. |
| `DATA_DIR` | `./data` | Persistent state and repository clones. |
| `POLL_INTERVAL_SECONDS` | `60` | Poll interval, integer of at least 10 seconds. |
| `HOST_PROC_DIR` | unset | Path to the local Docker host's proc filesystem for host CPU and memory metrics; see deployment instructions. |

Run the focused tests with `npm test`. They use temporary Git and Docker stand-ins and do not deploy containers.

## Behavior and limitations

- One operation per repository runs at a time; different repositories can deploy concurrently. Run only one Git Deploy instance against a data directory.
- Failed clones can be removed and re-added. A failed check or deployment stops automatic checks for that repository; inspect **Activity**, fix the cause, and deploy manually to resume. Interrupted operations are marked as errors on restart. A non-fast-forward remote change requires manual resolution.
- The custom script runs via `sh -c` in the clone directory, **after** Compose starts. It runs in the Git Deploy container when installed with Docker, not directly on the host, so only tools installed in that runtime are available. A failure marks the deployment as failed, but does not roll back containers. Commands have a 15-minute timeout; scripts must not detach or background long-running processes. Project Compose files must be in the repository root.
- The deployed count means a deployment previously succeeded, not that containers are currently healthy. This is not a full container management system or a substitute for backups and monitoring.
- Cards highlight rebuilding, paused, and recently pulled (60 seconds) states. The latest 200 activity chunks and the most recent 40,000 characters per repository are persisted; this feed is not a tamper-proof audit log.
- Removal only runs Compose cleanup when explicitly selected; `docker compose down --rmi local` can affect other deployments sharing a project name or built image. Volumes are not deleted.
- Managed tokens and unencrypted SSH private keys are stored in the protected data directory, not in a dedicated secret manager. Logs and scripts may contain sensitive information; do not print secrets. There is no multi-user access control, audit log, deployment queue, rollback, webhook, or container health monitoring yet.
- Repository `.env` files are stored unencrypted in the managed clone. The editor will not overwrite a Git-tracked `.env`; keep it ignored by Git. Changes take effect on the next deployment. See [deployment and security](DEPLOYMENT.md#repository-environment-files).

## Suggested next steps

Consider backups and a recovery plan, off-host health monitoring and notifications, deployment approvals, per-user permissions and an audit log, secret management, and rollback/version selection before relying on this for critical workloads. Webhooks could replace polling where network and authentication requirements permit.
