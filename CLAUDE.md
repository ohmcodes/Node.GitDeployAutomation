# Project instructions — Git Deploy (Node.js)

## Node app structure

- No bulky `server.js`. Split into modular folders: `/assets`, `/screens`, `/routes`, `/functions`, `/docs`, `/public`, `/test`, `/libs`, `/deploy`.
  - This repo currently uses `lib/` for server modules (routes, services, Docker and Git helpers), `public/` for the browser UI, `test/` for tests and `docs/` for documentation. Keep `server.js` as wiring only; put new logic in its own module.
- Always keep a `.env` sample (`.env.sample`), a `Dockerfile` and a Compose file (`compose.yaml`) up to date.
- While developing, always maintain and update:
  - `README.md` (for GitHub)
  - Developer docs
  - End-user docs
  - `CHANGELOG.md`
  - `FEATURES.md`
- For complex code, write a guideline doc (like a copilot) that teaches the developer and explains the reasoning behind decisions, to reduce technical debt.

## Project rules

- Security-sensitive actions (deploy, delete, container stop/kill/restart/pause, console) require a fresh authenticator code via `auth.authorizeAction`.
- Never pass `DEPLOY_TOKEN` to child processes; strip it from the environment.
- Run `npm test` before calling work done. Tests use Git/Docker stand-ins and never deploy real containers.
