# merge-manager

An observed-mode deterministic merge controller. GitHub webhooks are durable reconciliation signals; fresh GitHub state and trusted-base policy produce a PR-specific `merge-manager/shadow/pr-<number>` Check. Authorized collaborators can ask it to prepare, validate, land, retry, or cancel an exact integration candidate through PR comments. It does not run an agent or automatically authorize landing.

## Architecture

Fastify verifies the exact webhook bytes before JSON parsing and inserts each GitHub delivery into PostgreSQL. A periodic durable-outbox dispatcher sends deterministic pg-boss jobs and recovers undispatched or stranded rows. Workers route relevant events, fetch the PR, all files/reviews/check runs, and policy at the trusted base SHA, then hold a per-PR database lock while persisting and publishing one active immutable attempt. Facts and decisions remain database workflow truth. Check publication uses the attempt UUID as `external_id`, checks head and base freshness, and avoids digest-identical updates. A periodic sweep reconciles known open PRs to recover missed events and GitHub mergeability updates.

Relevant events are `pull_request` (state-changing actions), `pull_request_review` (submitted/edited/dismissed), and `check_run` (external completions and controller rerequests). Controller-created/completed checks are ignored to prevent recursion; unsupported events are durably recorded as ignored.

## GitHub App

Repository permissions: **Metadata: read**, **Pull requests: read**, **Checks: read/write**, **Contents: read/write**, and **Issues: read**. Subscribe to Pull request, Pull request review, Check run, and Issue comment events. Contents write is used only for namespaced candidate refs and an atomic force-with-lease target update after exact-SHA revalidation. Configure the webhook URL as `/github/webhooks` and use the same webhook secret as `GITHUB_WEBHOOK_SECRET`.

Observed-mode commands must be the complete PR comment and require the actor to currently have GitHub `write`, `maintain`, or `admin` permission:

```text
@merge-manager ready
@merge-manager retry
@merge-manager land
@merge-manager cancel
```

`ready`/`retry` freeze the PR head and current target SHA, construct a merge commit under `merge-manager/candidates/pr-<number>/<attempt>`, and evaluate required Checks on that exact candidate. `land` rechecks the PR head, target SHA, policy-bound candidate checks, and ancestry before using Git's atomic force-with-lease protocol to update the target only if it still equals the frozen SHA. Any movement marks the candidate stale instead of landing it.

## Local setup

Requires Node >=22.12 and PostgreSQL. Copy `.env.example` to `.env`, provide App credentials, then:

```sh
npm ci
npm test
npm run dev
```

The orb `.agents/setup` script idempotently provisions Node, dependencies, PostgreSQL, and a local `merge_manager` role/database; `.agents/resume` only restarts/checks PostgreSQL. The example database password is only for this local disposable environment and must not be used in a deployment. Environment files and secrets are not committed.

## Single-server deployment

Production runs on `merge.work-ops.app` with host-managed Caddy in front of a rootless Docker Compose stack containing this application and PostgreSQL. Every passing push to `main` publishes an immutable `ghcr.io/vasu014/merge-manager:<git-sha>` image. A rootless systemd timer on Hetzner reads the public repository's exact `main` SHA every two minutes and deploys the corresponding image after it becomes available. The server needs no GitHub or SSH deployment credential. Runtime secrets remain in `/opt/merge-manager/.env`.

Initial host setup:

1. Install Docker with its rootless extras, then run `deploy/bootstrap.sh` as root on Ubuntu. It creates a dedicated `deploy` user and rootless daemon without changing the system Docker daemon.
2. Copy `deploy/.env.example` to `/opt/merge-manager/.env`, replace every placeholder, and set mode `0600` owned by `deploy`.
3. Install `deploy/update.sh` in `/opt/merge-manager` and its service/timer files in the deploy user's systemd configuration.
4. Make the `ghcr.io/vasu014/merge-manager` container package public so the credential-free updater can pull it.
5. Install host-managed Caddy with `deploy/Caddyfile`, configure Cloudflare DNS for `merge.work-ops.app`, and use Full (strict) TLS. Do not challenge or cache `/github/webhooks`.

`deploy/deploy.sh` updates only the application container, waits for `/health`, and restores the previous immutable image if the new container fails. PostgreSQL data lives in a rootless Docker volume; Caddy reaches the application only on `127.0.0.1:3000`. Back up PostgreSQL off-host before treating this beta as durable.

## Policy

`.merge-manager/policy.json` is read from each PR's **base SHA** and validated with Zod. This repository requires its GitHub Actions `ci` check. Missing policy files in other repositories use conservative size limits but no repository-specific required checks. Invalid policy fails reconciliation rather than becoming eligible. Required checks accept `{ "name": "ci", "appId": 123 }`, where `appId` is optional. Missing, pending, or ambiguous required checks wait; failures require author action.

Forks and changes to `.merge-manager/**`, `.github/workflows/**`, `.agents/**`, or configured sensitive path prefixes require human review. Oversize changes, requested changes, merge conflicts, drafts, and unknown mergeability are handled conservatively. Observer eligibility is informational only and never authorizes or performs landing in this slice.
