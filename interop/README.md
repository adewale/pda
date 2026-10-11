# Poppy interop harness

Runs every Personal Agent implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) against every Company implementation, in containers, over HTTPS through a recording proxy, and blames each failure on a side by a named rule. The contract an implementation meets is [`docs/interop-spec.md`](../docs/interop-spec.md); the design and its sources are in [`docs/interop-testing.md`](../docs/interop-testing.md).

## Run it

Needs Node 22.18 or later, Docker (Docker Desktop, colima, or Docker on Linux) and `openssl`.

```sh
npm ci --legacy-peer-deps
npm run interop                                        # everything in the registry
npm run interop -- --agents dpa --companies dpa-mock   # one pair
npm run interop -- --scenarios D,SD,O --no-build       # some scenarios, reusing built images
npm run interop -- --set dpa:INTEROP_FAULT=assertion-typ --scenarios S0   # a deliberately broken agent
```

| Option | Meaning |
| --- | --- |
| `--agents a,b`, `--companies x,y` | Implementations by registry name; all of each role by default. |
| `--scenarios D,SD` | Scenario ids; all by default. |
| `--lane local\|live` | `local` (default): containers on a private network. `live`: our agent against registry entries with a `url`, signed-out scenarios only, one request a second. |
| `--no-build` | Use the images already built. |
| `--keep` | Leave the containers and network running afterwards, for debugging. |
| `--no-retry` | Don't run a failed or errored cell a second time. |
| `--min-free-gb n` | Refuse to start with less than `n` GB free on Docker's data disk (default 2). |
| `--set name:KEY=VALUE` | Extra environment for one implementation's container. |
| `--out dir` | Where to write results, instead of `interop/results/<run>/`. |

Each run writes:

- `results.json`: every cell's outcome, blame, rule, steps and checks (spec section 9).
- `index.html`: one grid per scenario, agents as rows and Companies as columns; a cell links to its steps, checks and HAR.
- `<scenario>/<agent>__<company>.har`: everything that crossed the proxy in that cell, unredacted (every key and token is made for the run).
- `logs/`: image builds and each container's output.

A cell that fails or errors runs once more, with both adapters reset again; its first run's HAR is kept beside the second's (`<agent>__<company>.attempt2.har`) and `attempts` in `results.json` records both. A cell that passes the second time is **flaky**: it counts as a pass, is listed apart in the console and the report, and never matches a known failure.

The runner exits 1 when a cell fails or errors and isn't in `known-failures.json`, or when a known failure is stale: it matched no failed cell though the run could judge it (each name it gives ran, and each `*` spans every agent, Company or scenario of the lane), so it is fixed or wrong. A partial run never judges an entry for cells it didn't run.

### Docker hygiene

Everything a run creates on Docker, its containers, network and any volumes, carries the label `interop.run=<tag>`, where the tag is the run's random one (printed at the start, and in container names, `poppy-interop-<tag>-...`). The runner removes exactly those when it exits, when it fails and on Ctrl-C or SIGTERM, unless `--keep`. It never removes images (the next run reuses them), never touches the build cache, and never removes anything without its own run's label. To clear a run left by `--keep` or a killed runner: `docker rm -f -v $(docker ps -aq --filter label=interop.run=<tag>)`, then `docker network rm $(docker network ls -q --filter label=interop.run=<tag>)`.

Before it starts, the runner checks free space on Docker's data disk, running `df -Pk /` in a short-lived container of the proxy image, and refuses to start below `--min-free-gb` (2 GB by default), saying how much there is. A first run, before the proxy image is built, skips the check.

The latest grid, for readers who don't run it, is in [`docs/interop-results/`](../docs/interop-results/): [`results.json`](../docs/interop-results/results.json) and [`index.html`](../docs/interop-results/index.html) (open it locally or through a raw-HTML viewer; its HAR links point at files that aren't committed). Its [README](../docs/interop-results/README.md) says which implementations and commits it covers.

## How a cell runs

1. Both adapters get `POST /reset`; the proxy starts a new recording.
2. The Company's `fixture` hook says what the scenario may use: accounts, the scopes to sign in with (`scopes.read`, `scopes.write`; Poppy's when absent), API operations, prompts for its agent.
3. The scenario's steps run in order: agent steps through `POST /step`, Company steps through `POST /hooks/<name>`, runner steps (`wait`, `fetch`, `assert_trace`) in the runner. Each `save`d result can be referred to later as `${name.path}`, and `expect` steps compare them.
4. The checker reads the recording: trace checks (assertions, DPoP proofs, tokens in URLs, token hosts, redirects, Retry-After, Company error shapes), `src/validator` over every discovery document and client metadata served, the agent's declared readings, and any violations the Company adapter recorded (`GET /violations`).
5. Attribution blames a failed cell by the first rule that decides it: violation, grid, reading, or unattributed. A violation a Company recorded that is exactly a declared reading difference (a strict Company refusing a typ-less assertion from an agent that declared S2 `any`) is a reading, not a violation. So is a refusal the trace shows and the Company's declared reading explains (`reading.<id>.refused`: `invalid_client` for an `aud` its S1 reading doesn't accept, `invalid_grant` for an assertion its S2 `jwt-60s` refuses), when the agent declared an incompatible reading. Rule 3 needs that evidence: two sides that merely declare different readings of a question the scenario lists aren't blamed on the spec unless the trace shows the question mattered.

## Layout

```text
registry.json        Implementations: name, role, pinned commit, where to build
known-failures.json  Failures with an issue link and a reason; they don't fail the run, but a stale one does. "*" matches any agent, Company or scenario
scenarios/           One JSON file per scenario (spec section 6)
runner/              The CLI, cell runner, checks, attribution and report
proxy/               The recording TLS proxy (Node, no dependencies)
impls/dpa-agent/     Our agent: src/poppy in Node, no model
impls/dpa-mock/      Our strict mock Company (test/mock-company) behind the hooks API
impls/shared/        What our two adapters share: the HTTP shim and the esbuild bundle
vectors/             One-sided cases for other implementations' testers (spec section 11)
test/                Unit tests for the runner, in Node (interop/vitest.config.ts, part of npm test)
```

## Add an implementation

1. Write an adapter in `interop/impls/<name>-agent/` or `interop/impls/<name>-company/` with a `Dockerfile` whose base images are pinned by digest ([Base images](#base-images)). The container serves the implementation on port 8080 (plain HTTP; the proxy terminates TLS) and the adapter API on port 8081:
   - every adapter: `GET /manifest`, `GET /healthz`, `POST /reset` (spec section 5.1);
   - an agent: `POST /step` (5.2), driving the implementation's own protocol code, never a model;
   - a Company: `GET /hooks` and `POST /hooks/<name>` (5.3), and `GET /violations` if it records the agent's mistakes.
2. Build URLs from `INTEROP_ORIGIN`, trust `/interop/ca.pem`, and authenticate control calls with `INTEROP_SECRET`. Any relaxation the implementation needs (accepting `*.interop.test`, a private CA, an unknown peer) must be a setting that is off by default, listed in the manifest's `relaxations`.
3. Add an entry to `registry.json` with a pinned `commit`. A Company that serves subdomains beyond the defaults lists them in `subdomains`.
4. Run `npm run interop -- --agents dpa --companies <name>` (or the converse) and look at `index.html`.
5. A failure that is real and reported upstream can go in `known-failures.json` with its issue link and a reason. One root cause is one entry: use `"*"` for the agent, Company or scenario it spans (`{"agent": "pi-poppy", "company": "*", "scenario": "SE"}`). The most specific matching entry wins; an entry that matched no failure in a run that could judge it is stale and fails the run, so remove it once the failure is fixed.

## Our adapters

**dpa-agent** bundles `src/poppy` with esbuild and runs it in Node: the same `PoppyClient`, sign-in, conversation, API and operations code the Durable Object runs. Node's built-in SQLite stands in for the Durable Object's (`impls/dpa-agent/sqlite.ts` implements the part of `SqlStorage` src/poppy uses), and jobs the Durable Object would schedule run when a step waits on them. It needs no relaxation: `*.interop.test` names pass src/poppy's public-host check, and Node trusts the run's CA. `INTEROP_FAULT=assertion-typ` re-signs every client and Session assertion without `typ`, in the adapter's network seam, to prove attribution; it is off unless set and never reaches `src/`.

**dpa-mock** runs the conformance suite's mock Company unchanged, moved to `<name>.company.interop.test` by `placeCompanies` in `test/mock-company/types.ts`. It rotates Account Tokens and polls devices every second. Its hooks map to the RPC the conformance tests use, and every violation it records becomes an agent-side error check. `INTEROP_MOCK_PROFILE` picks its settings: `dpa-mock`, the reference Company for attribution rule 2, runs the S2-lenient profile (`strictAssertions: false`, as the conformance suite's "lenient assertions" profile: no `typ` or `kid` needed, assertions up to 300 s) and declares S2 `any`, since the spec treats S2 as a warning; **dpa-mock-strict** is the same image with `INTEROP_MOCK_PROFILE=strict` (registry `env`), refuses assertions without `typ: "JWT"`, a published `kid` and a 60-second lifetime, and declares S2 `jwt-60s`. A typ-less agent that declares S2 `any` fails there by rule 3 (reading), not rule 1.

## Base images

Every `FROM` names its tag and the digest of that tag's multi-arch index, such as `FROM node:24-slim@sha256:…`, so a rebuild gets the same image on amd64 and arm64 until we choose to move. Docker uses the digest and ignores the tag, which is there for readers. A new adapter's `Dockerfile` pins the same way.

To update a pin, read the tag's current index digest without pulling, and replace the digest in every `FROM` that uses the tag:

```sh
docker buildx imagetools inspect node:24-slim | grep -m1 '^Digest:'   # the index, not a per-platform manifest
grep -rn '^FROM node:24-slim@' interop/                                # where it's used
```

Check that `MediaType` is an image index (`…image.index…` or `…manifest.list…`) listing `linux/amd64` and `linux/arm64`, then rebuild the images that use it and run the grid.

## Vectors

`vectors/validator.json` and `vectors/mock-company.json` are generated from `test/validator.test.ts` and `test/mock-company.test.ts`. After changing a fixture or a tamper row, run `npm run interop:vectors`; until then the tests that generate them fail.
