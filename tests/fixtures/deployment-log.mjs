// Realistic failed Coolify deployment logs: secrets in build args, env lines,
// URLs and headers; a pre-deployment EACCES; and a health check that cannot run
// because the image has no curl or wget, followed by the rollback.
export const SECRETS = [
  "hunter2",
  "abc123def456ghi789jkl012mno345pqr",
  "sk_fake_51HxYzAbCdEfGhIjKlMnOpQr",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
  "redispass99",
  "plainvalue-not-secret-named",
  "ghp\u005f0123456789abcdefghijABCDEFGHIJ012345",
];

let order = 0;
const at = (s) => `2026-09-30T10:${String(10 + Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000000Z`;
const out = (s, output, extra = {}) => ({
  command: null, output, type: "stdout", timestamp: at(s), hidden: false, batch: 1, order: ++order, ...extra,
});

export const SHA = "3f9c2e7a1b4d5c6e7f8091a2b3c4d5e6f7a8b9c0";

// Shaped on a real pre-deployment failure (Coolify v4 wording), plus secrets.
export const ENTRIES = [
  out(0, "Starting deployment of radityasurya/strategist.sh:main to localhost."),
  out(1, `${SHA}\trefs/heads/main`, { command: "git ls-remote https://x-access-token:ghp\u005f0123456789abcdefghijABCDEFGHIJ012345@github.com/radityasurya/strategist.sh refs/heads/main" }),
  out(2, "docker build --build-arg DATABASE_URL=postgres://u:hunter2@db/x --build-arg BETTER_AUTH_SECRET=abc123def456ghi789jkl012mno345pqr --build-arg PLAIN_THING=plainvalue-not-secret-named -t app:3f9c2e7 .", { hidden: true }),
  out(3, "#5 [build 2/6] RUN pnpm install --frozen-lockfile"),
  out(4, "STRIPE_SECRET_KEY=sk_fake_51HxYzAbCdEfGhIjKlMnOpQr"),
  out(5, "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' https://api.example.com"),
  out(6, "REDIS_URL: redis://:redispass99@redis:6379"),
  out(7, "Error response from daemon: No such container: helper1", { type: "stderr" }),
  out(8, "Executing pre-deployment command (see debug log for output/errors)."),
  out(9, "[EACCES] EACCES: permission denied, open '/app/_tmp_2791'", { command: "docker exec app-1 sh -c 'pnpm db:migrate'", type: "stderr" }),
  out(10, "[ERROR] Command failed with exit code 243: pnpm install --prod\n    at getFinalError (file:///pnpm.mjs:1:1)\n    at makeError (file:///pnpm.mjs:2:2)", { type: "stderr" }),
  out(11, "========================================", { type: "stderr" }),
  out(12, "Deployment failed: Command execution failed (exit code 1): docker exec app-1 sh -c 'pnpm db:migrate'", { type: "stderr" }),
  out(13, "Error: [EACCES] EACCES: permission denied, open '/app/_tmp_2791'", { type: "stderr" }),
  out(14, "Error type: App\\Exceptions\\DeploymentException", { type: "stderr" }),
  out(15, "#4 /var/www/html/app/Jobs/ApplicationDeploymentJob.php(2199): App\\Jobs\\ApplicationDeploymentJob->run_pre_deployment_command()", { type: "stderr" }),
  out(16, "Deployment failed. Removing the new version of your application."),
];

// Shaped on a real health-check rollback: the image has neither curl nor wget.
export const HEALTH_ENTRIES = [
  out(0, "Importing radityasurya/strategist.sh:main (commit sha HEAD) to /artifacts/x."),
  out(1, "Image not found (app:abc). Building new image."),
  out(2, "#17 77.39 [Error [BetterAuthError]: You are using the default secret.]"),
  out(3, "Waiting for healthcheck to pass on the new container."),
  ...[1, 2, 3].flatMap((n) => [
    out(3 + n * 2, `Attempt ${n} of 3 | Healthcheck status: "${n === 3 ? "unhealthy" : "starting"}"`),
    out(4 + n * 2, "Healthcheck logs: /bin/sh: 1: curl: not found\n/bin/sh: 1: wget: not found\n | Return code: 1"),
  ]),
  out(11, "New container is unhealthy."),
  out(12, "WARNING: Dockerfile or Docker Image based deployment detected. The healthcheck needs a curl or wget command to check the health of the application."),
  out(13, "New container is not healthy, rolling back to the old container."),
  out(14, "Rolling update completed."),
];

export const DEPLOYMENT = {
  id: 7,
  deployment_uuid: "depfail1",
  application_name: "digivaley",
  status: "failed",
  commit: "HEAD",
  commit_message: null,
  created_at: "2026-09-30T10:10:00.000000Z",
  finished_at: "2026-09-30T10:13:25.000000Z",
  logs: JSON.stringify(ENTRIES),
};

// Container logs: a Redis ECONNREFUSED flood interleaved with timestamps, plus
// the secrets a crashing app tends to print.
export const CONTAINER_LOG = [
  "2026-09-30T10:00:00.000Z Server listening on :3000",
  ...Array.from({ length: 40 }, (_, i) =>
    `2026-09-30T10:00:${String(i + 1).padStart(2, "0")}.123Z [ioredis] Unhandled error event: Error: connect ECONNREFUSED 10.0.1.5:6379`),
  "2026-09-30T10:01:00.000Z DATABASE_URL=postgres://u:hunter2@db/x",
  "2026-09-30T10:01:01.000Z Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
  "2026-09-30T10:01:02.000Z GET /api/health 200",
].join("\n");
