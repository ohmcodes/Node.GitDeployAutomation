# Deployment and operations

## Security first

Git Deploy is a single-administrator tool. The token grants the ability to clone repositories, execute custom scripts, build arbitrary Dockerfiles and control the Docker daemon. The Docker socket and the default container's root user give effectively unrestricted access to the host. Only connect trusted repositories and use scripts you have reviewed. A malicious repository or Compose file can compromise the host.

The HTTP server has no built-in TLS, user accounts, rate limiting, or audit trail. The supplied Compose configuration binds its port to host loopback only. Access it locally, through an SSH tunnel, or through a properly secured HTTPS reverse proxy/VPN with additional access controls. Never publish port 3000 directly to the internet. Keep the token out of Git, logs and screenshots; use a long randomly generated token, protect the environment and rotate it by changing the value and restarting the service. Browser session storage holds the token until logout or the tab's session ends. Protect the browser and deployment host.

State, scripts, Git URLs, and the most recent command output are stored in `DATA_DIR/state.json`; cloned source is under `DATA_DIR/repos`. Output may contain application secrets, including the last 100 log lines from each Compose service. Protect the data directory and backups, and avoid logging credentials. URL-embedded HTTPS credentials are rejected. The token is not passed to deployment child processes.

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

3. Open `http://127.0.0.1:3000` on that host. From another machine, an SSH tunnel is one option: `ssh -L 3000:127.0.0.1:3000 user@your-docker-host`, then open `http://127.0.0.1:3000` locally.

The container mounts `/var/run/docker.sock` and `/srv/git-deploy`. The **same absolute path** must be mounted inside the container and exist on the Docker daemon host: Compose bind mounts in managed projects are resolved by the host daemon, not inside Git Deploy. If you change the data path, change both sides of the volume mount and `DATA_DIR` together. This setup assumes a local Docker daemon and a Linux host.

To upgrade, back up the data directory, update the Git Deploy source, and rerun `docker compose up -d --build`. To stop Git Deploy, use `docker compose down` in this project's directory; this does not stop the separately deployed projects. To back up, stop Git Deploy and copy `/srv/git-deploy` securely; preserve the same path when restoring so project bind mounts continue to work.

## Private repositories

Public HTTPS URLs work without configuration. For SSH, use a URL such as `ssh://git@github.com/owner/repository.git` (the `git@host:path` shorthand is not supported). Configure a read-only deploy key and verified host keys for the operating-system user running Git Deploy. For the supplied container, mount a protected, preconfigured SSH directory read-only at `/root/.ssh` in a Compose override; make sure key permissions are acceptable to OpenSSH. Verify host key fingerprints independently; do not disable host key checking. Git runs noninteractively, so keys must work without interactive prompts. For private HTTPS, configure a noninteractive Git credential helper in the runtime environment; never put credentials in the URL or custom scripts.

## Troubleshooting

- **Cannot start:** `DEPLOY_TOKEN` must be at least 16 characters, and the poll interval must be an integer of 10 or more.
- **Clone fails:** inspect **Activity** for the Git error; check URL, branch, network, and noninteractive credentials. Remove the failed entry and add it again.
- **Deploy fails:** inspect **Activity** for Git, Compose, or script output. Verify the Compose file, Docker access, project environment files and port availability. Fix the issue and select **Deploy** again.
- **Watching stops:** any failed check or deployment requires a successful manual deploy to resume polling. If the branch was force-pushed, resolve the checkout manually rather than automatically discarding local changes.
- **Unexpected service state:** `docker compose ps` and logs are snapshots taken during deployment, not continuous health checks. Inspect the managed project with Docker directly.
