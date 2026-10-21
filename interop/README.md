# Poppy interop harness

Runs every Personal Agent implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) against every Company implementation, in containers, over HTTPS through a recording proxy, and blames each failure on a side by a named rule. The contract an implementation meets is [`docs/interop-spec.md`](../docs/interop-spec.md); the design and its sources are in [`docs/interop-testing.md`](../docs/interop-testing.md).

## Run it

Needs Node 24 or later, Docker (Docker Desktop, colima, or Docker on Linux) and `openssl`.

```sh
npm ci --legacy-peer-deps
npm run interop                                        # everything in the registry
npm run interop -- --agents pda --companies pda-mock   # one pair
npm run interop -- --scenarios D,SD,O --no-build       # some scenarios, reusing built images
npm run interop -- --set pda:INTEROP_FAULT=assertion-typ --scenarios S0   # a deliberately broken agent
```

| Option | Meaning |
| --- | --- |
| `--agents a,b`, `--companies x,y` | Implementations by registry name; all of each role by default. |
| `--scenarios D,SD` | Scenario ids; all by default. |
| `--lane local\|live` | `local` (default): containers on a private network with no internet access ([Isolation](#isolation)). `live`: our agent against registry entries with a `url`, signed-out scenarios only, one request a second. |
| `--no-build` | Use the images already built. |
| `--build-jobs n` | Build at most `n` images concurrently (default 2), to bound compilation memory and disk pressure. |
| `--keep` | Leave the containers and network running afterwards, for debugging. |
| `--no-retry` | Don't run a failed or errored cell a second time. |
| `--min-free-gb n` | Refuse to start with less than `n` GB free on Docker's data disk (default 2). |
| `--set name:KEY=VALUE` | Extra environment for one implementation's container. |
| `--out dir` | Where to write results, instead of `interop/results/<run>/`. |
| `--image-tag tag` | Build and run under a Docker tag (default `latest`); `--image-tag adv` keeps a full grid run's `:latest` images untouched. The only way to keep a side build of our images: don't `docker tag` them by hand, and `docker image rm poppy-interop/<image>:<tag>` a side tag when you're done with it (the runner never removes images). |

**Adversarial cells** (the malicious `evil-agent`/`evil-company` and the fault-injection proxy; [`docs/adversarial-interop.md`](../docs/adversarial-interop.md)) run only against our own `owner: "self"` implementations, on the local lane, never live, with one exception: `evil-company` may attack other projects' agents. No flag lifts the rest ([`SECURITY.md`](../SECURITY.md), [`docs/interop-spec.md`](../docs/interop-spec.md) §13). They appear in a separate security grid in `index.html` and never count toward the interop pass rates. Run with no `--agents` and `--scenarios`, `npm run interop` pairs every adversarial scenario with every implementation too; the runner refuses each such cell with a third-party side, other than an agent facing `evil-company`, before anything is sent and records it as `error`, blame `harness` (spec §13), so that command always exits 1. A full grid is the honest scenarios with every agent and Company ([the command](../docs/interop-results/README.md)) plus the three security commands below.

```sh
npm run interop -- --image-tag adv --agents evil-agent --companies pda-mock,pda-mock-strict --scenarios YR,YD,YA,YT,YS,YK,YU,YM
npm run interop -- --image-tag adv --agents pda --companies evil-company --scenarios XH,XI,BX,XB,XN,XO,XP,XE,XR,XT
npm run interop -- --image-tag adv --agents pda --companies pda-mock,pda-mock-strict --scenarios NREP,CDUP,CIDUP,ODUP
```

`--image-tag adv` builds our images under a side tag so a grid run in progress keeps its `:latest` ones. When no grid is running, `--no-build` reuses `:latest` instead (`evil-agent` and `evil-company` are our two images with `INTEROP_ADVERSARY` set). A side tag stays on Docker's disk until you remove it: `docker image rm poppy-interop/agent-pda:adv poppy-interop/company-pda-mock:adv poppy-interop/proxy:adv`.

Each run writes:

- `results.json`: every cell's outcome, blame, rule, steps and checks (spec section 9).
- `index.html`: one grid per scenario, agents as rows and Companies as columns; a cell links to its steps, checks and HAR.
- `<scenario>/<agent>__<company>.har`: everything that crossed the proxy in that cell, unredacted (every key and token is made for the run).
- `logs/`: image builds and each container's output.

A cell that fails or errors runs once more, with both adapters reset again; its first run's HAR is kept beside the second's (`<agent>__<company>.attempt2.har`) and `attempts` in `results.json` records both. A cell that passes the second time is **flaky**: it counts as a pass, is listed apart in the console and the report, and never matches a known failure.

The runner exits 1 in two cases. One is a cell that fails or errors without matching an entry of `known-failures.json`; an entry names its cells and the blame, error checks and failed step's code it expects, so a different failure in the same cell is unexpected. The other is a stale known failure, one that matched no failed cell though the run could judge it (each name it gives ran, and each `*` spans every agent, Company or scenario of the lane, leaving aside the adversarial ones, which run apart): it is fixed or wrong. A partial run never judges an entry for cells it didn't run.

### Isolation

The local lane never touches a real system. Its network is created `--internal`: no container on it, ours or a third party's, has a route out, and Docker's resolver answers only the run's names. No flag or setting turns this off.

- **Proof, every run.** Before any implementation starts, the runner checks that Docker reports the network internal, then runs a probe with `docker exec` in the proxy (on the internal network only, like every implementation): TCP to `1.1.1.1:443` and `8.8.8.8:53`, and a DNS lookup of `example.com`. All three must fail, or the run stops. The console prints the outcome (`isolation: … {"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}`), and `results.json` keeps it as `isolation`.
- **How the runner still reaches its containers.** An internal network can't publish ports, so the proxy's control port is reached through a relay: a second container of the proxy image (`proxy/relay.mjs`) on both the internal network and an ordinary per-run one, which publishes only its own port on `127.0.0.1` and forwards to the proxy's control port and nowhere else. Adapters' control calls go through the proxy's `/control`, and the relay's traffic isn't recorded in the HAR.
- **Host proxy settings and file permissions.** The local lane sets both `NO_PROXY` and `no_proxy` for `.interop.test`, `localhost` and `127.0.0.1`, so Docker's inherited external proxy settings cannot divert private protocol requests. The public CA directory and certificate are explicitly readable by non-root adapters; private keys stay outside that directory. Non-root images create traversable adapter directories before copying readable entry files: on a fresh build, `COPY --chmod=0644` can also leave new parent directories without execute permission. Container logs in both lanes retain stdout and stderr, including startup failures.
- **An implementation that needs the internet at runtime** fails its cells. That is a finding: record it in `known-failures.json` with what it tried to reach (from its log in `logs/`). Never open the network for it. Fetch what an image needs when it is built.
- **The live lane** (`--lane live`, first run on 13 October against `alpine-retail-live`; [interop-spec §10](../docs/interop-spec.md#10-lanes)) needs the internet by definition, and is kept apart: it creates no network, runs only our own agent on Docker's default bridge, and no third-party image. `S0`, `N` and `C` need [its identity](#the-live-lanes-identity).

### The live lane's identity

A public Company fetches the agent's `client_id`. The local lane's, on `pda.agent.interop.test`, is fetchable only inside the run, so a live Company that checks client metadata refuses `S0`, `N` and `C` with `invalid_client`. The fix is a second Poppy client served by our deployed Worker, the interop test client, whose private key only your machine holds. It is separate from the real client: its own `client_id` and key, no redirect URI, and no access to anyone's agent. To set it up, once per deployment:

1. Make the key. In the checkout you run the harness from:

   ```sh
   node scripts/interop-live-identity.mjs        # the origin comes from deployment.local.json's PUBLIC_ORIGIN
   node scripts/interop-live-identity.mjs --origin https://<your deployment>   # or say it
   ```

   It writes the private key and the `client_id` to `interop/.live-identity.json` (git ignores it; mode 600) and prints only the public key set. It never prints the private key. Run it again to print the same public key set; `--new` replaces the key.
2. Put the public key set in your untracked `deployment.local.json` as `"INTEROP_LIVE_JWKS": {"keys": [...]}`, exactly as printed.
3. Deploy: `npm run deploy`. Check that `<origin>/poppy/interop/client.json` and `<origin>/poppy/interop/jwks.json` answer, for example with `npm run validate -- <origin>/poppy/interop/client.json`.

Then `npm run interop -- --lane live` prints `live identity: <origin>/poppy/interop/client.json` before it starts, and gives the `client_id` and key to our own agent's container only (the key through the docker CLI's environment, never its arguments). Without the file it prints why `S0`, `N` and `C` will fail, and runs as before. To turn the interop client off, set `INTEROP_LIVE_JWKS` back to `""` and deploy; both routes then answer 404. A Company that requires registration needs the interop client registered on its own: approving the real client doesn't cover it.

Static hosting can add a path prefix before `/poppy/interop/client.json`. The matching `jwks.json` must be beside that document. Set the full public `client_id` in the local identity file and metadata. Serve both as `application/json`; raw GitHub responses are `text/plain` and some Companies refuse them. See [the live 0.2 results](../docs/live-0.2-testing.md) for the tested setup.

### Docker hygiene

Everything a run creates on Docker (its containers, two networks, the internal one and the relay's, and any volumes) carries the label `interop.run=<tag>`, where the tag is the run's random one (printed at the start, and in container names, `poppy-interop-<tag>-...`). The runner removes exactly those when it exits, when it fails and on Ctrl-C or SIGTERM, unless `--keep`. It never removes images (the next run reuses them), never touches the build cache, and never removes anything without its own run's label. To clear a run left by `--keep` or a killed runner: `docker rm -f -v $(docker ps -aq --filter label=interop.run=<tag>)`, then `docker network rm $(docker network ls -q --filter label=interop.run=<tag>)`.

Before it starts, the runner checks free space on Docker's data disk, running `df -Pk /` in a short-lived container of the proxy image, and refuses to start below `--min-free-gb` (2 GB by default), saying how much there is. A first run, before the proxy image is built, skips the check.

### Resources

A full grid builds about 20 images; with Docker's build cache they take roughly 100 GB, so give Docker's disk room (`--min-free-gb` refuses to start below a floor). Compiling `everruns-server` needs more memory than an 8 GB Linux VM has: in a colima or Docker Desktop VM of that size, add about 6 GB of swap first (for colima, a swap file in the VM listed in its `/etc/fstab`), or build without the everruns adapters. The runner never removes images; `docker images 'poppy-interop/*'` lists them, and a side tag (`--image-tag`) stays until you remove it.

Results aren't committed. A summary of the last full grid, for readers who don't run it, is in [`docs/interop-results/README.md`](../docs/interop-results/README.md): a snapshot of one run, with the implementations and commits it covered, the totals, the matrix and the causes of each failure. For the full results, run the grid (output in `results/<run>/`, gitignored) or download the `interop-results` artifact that CI's Interop workflow (`.github/workflows/interop.yml`) uploads.

## How a cell runs

1. Both adapters get `POST /reset`; the proxy starts a new recording.
2. The Company's `fixture` hook says what the scenario may use: accounts, the scopes to sign in with (`scopes.read`, `scopes.write`; Poppy's when absent), API operations, prompts for its agent.
3. The scenario's steps run in order: agent steps through `POST /step`, Company steps through `POST /hooks/<name>`, runner steps (`first`, `wait`, `fetch`, `assert_trace`) in the runner. Each `save`d result can be referred to later as `${name.path}`, and `expect` steps compare them.
4. The checker reads the recording: trace checks (assertions, DPoP proofs, tokens in URLs, token hosts, redirects, Retry-After, Company error shapes, the fields 7.5 requires of a read of events, browser joins and their cookies, handoff answers, a parent's refusals while its Direct Conversation is open, repeated confirms, and the Company's fetches of the agent's documents), `src/validator` over every discovery document and client metadata served, the agent's declared readings, and any violations the Company adapter recorded (`GET /violations`).
5. Attribution blames a failed cell by the first rule that decides it: adversarial (for a cell with an adversarial side), violation, warning, grid, reading, or unattributed (spec section 9). A violation a Company recorded that is exactly a declared reading difference (a strict Company refusing a typ-less assertion from an agent that declared S2 `any`) is a reading, not a violation. So is a refusal the trace shows and the Company's declared reading explains (`reading.<id>.refused`: `invalid_client` for an `aud` its S1 reading doesn't accept, `invalid_grant` for an assertion its S2 `jwt-60s` refuses), when the agent declared an incompatible reading. Rule 3 needs that evidence: two sides that merely declare different readings of a question the scenario lists aren't blamed on the spec unless the trace shows the question mattered.

## Layout

```text
registry.json        Implementations: name, role, pinned commit, where to build
known-failures.json  Failures with an issue link, a reason, and what they look like (blame, error checks, step error); they don't fail the run, but a stale one does. "*" matches any agent, Company or scenario
scenarios/           One JSON file per scenario (spec section 6)
files/               Files scenarios upload (an api step's args.files): lake.jpg, a 480×360 photo drawn for the purpose
runner/              The CLI, cell runner, checks, attribution and report
proxy/               The recording TLS proxy and the control relay (Node, no dependencies)
impls/pda-agent/     Our agent: src/poppy in Node, no model
impls/pda-mock/      Our mock Company (test/mock-company) behind the hooks API, as pda-mock (lenient) and pda-mock-strict
impls/shared/        What our two adapters share: the HTTP shim, the esbuild bundle, and the mock's hooks (mock-hooks.ts, also used by test/hypothesis)
vectors/datalayer/   Runs Datalayer's conformance cases against src/poppy and src/validator (spec section 11)
vectors/validators/  Our validator against poppy-validator and poppy-sidecar on the same documents
test/                Unit tests for the runner, in Node (interop/vitest.config.ts, part of npm test)
```

## Add an implementation

1. Write an adapter in `interop/impls/<name>-agent/` or `interop/impls/<name>-company/` with a `Dockerfile` whose base images are pinned by digest ([Base images](#base-images)). The container serves the implementation on port 8080 (plain HTTP; the proxy terminates TLS) and the adapter API on port 8081:
   - every adapter: `GET /manifest`, `GET /healthz`, `POST /reset` (spec section 5.1);
   - an agent: `POST /step` (5.2), driving the implementation's own protocol code, never a model;
   - a Company: `GET /hooks` and `POST /hooks/<name>` (5.3), and `GET /violations` if it records the agent's mistakes.
2. Build URLs from `INTEROP_ORIGIN`, trust `/interop/ca.pem`, and authenticate control calls with `INTEROP_SECRET`. Any relaxation the implementation needs (accepting `*.interop.test`, a private CA, an unknown peer) must be a setting that is off by default, listed in the manifest's `relaxations`.
3. Add an entry to `registry.json` with a pinned `commit`. A Company that serves subdomains beyond the defaults lists them in `subdomains`.
4. Run `npm run interop -- --agents pda --companies <name>` (or the converse) and look at `index.html`.
5. A failure that is real and reported upstream can go in `known-failures.json` with its issue link and a reason. One root cause is one entry: use `"*"` for the agent, Company or scenario it spans (`{"agent": "pi-poppy", "company": "*", "scenario": "SE", "blame": "agent", "errors": ["invalid_session"]}`). Copy what the failure looks like from `results.json`: `blame` (required; `null` when unattributed), `checks` (the cell's error check ids) and `errors` (its first failed step's code: a refusal's Poppy error, `expect <path>`, or `error`; [interop spec](../docs/interop-spec.md) section 9). A cell in the entry's span that fails some other way is unexpected, and its reason says what differed. The most specific matching entry wins; an entry that matched no failure in a run that could judge it is stale and fails the run, so remove it once the failure is fixed, or correct it once the failure changes.

## Our adapters

**pda-agent** bundles `src/poppy` with esbuild and runs it in Node: the same `PoppyClient`, sign-in, conversation, API and operations code the Durable Object runs. Node's built-in SQLite stands in for the Durable Object's (`impls/pda-agent/sqlite.ts` implements the part of `SqlStorage` src/poppy uses), and jobs the Durable Object would schedule run when a step waits on them. It needs no relaxation: `*.interop.test` names pass src/poppy's public-host check, and Node trusts the run's CA. `web_join` (scenario W) browses as `poppy_browse` does, with src/poppy's fetch-based browser, which joins the Session and follows the 303 with the Company's cookie; Node has no `HTMLRewriter`, so the adapter stands in one that reads every page as empty (W judges the join on the wire, not what a page says). `confirm_again` (O2) sends the agent's recorded confirm again through the client's own DPoP-bound request, since src/poppy never re-confirms an operation it knows was confirmed. `INTEROP_FAULT=assertion-typ` re-signs every client and Session assertion without `typ`, in the adapter's network seam, to prove attribution; it is off unless set and never reaches `src/`. In the live lane, `INTEROP_LIVE_CLIENT_ID` and `INTEROP_LIVE_KEY` make it sign as the interop test client ([above](#the-live-lanes-identity); `impls/pda-agent/live-identity.ts`), with src/poppy's `PoppyClient` unchanged but for its `identity`.

**pda-mock** runs the conformance suite's mock Company unchanged, moved to `<name>.company.interop.test` by `placeCompanies` in `test/mock-company/types.ts`. It rotates Account Tokens and polls devices every second. Its hooks map to the RPC the conformance tests use, and every violation it records becomes an agent-side error check. `INTEROP_MOCK_PROFILE` picks its settings: `pda-mock`, the reference Company for attribution rule 2, runs the S2-lenient profile (`strictAssertions: false`, as the conformance suite's "lenient assertions" profile: no `typ` or `kid` needed, assertions up to 300 s) and declares S2 `any`, since the spec treats S2 as a warning; **pda-mock-strict** is the same image with `INTEROP_MOCK_PROFILE=strict` (registry `env`), refuses assertions without `typ: "JWT"`, a published `kid` and a 60-second lifetime, and declares S2 `jwt-60s`. A typ-less agent that declares S2 `any` fails there by rule 3 (reading), not rule 1.

## Base images

Every `FROM` names its tag and the digest of that tag's multi-arch index, such as `FROM node:24-slim@sha256:…`, so a rebuild gets the same image on amd64 and arm64 until we choose to move. Docker uses the digest and ignores the tag, which is there for readers. A new adapter's `Dockerfile` pins the same way.

To update a pin, read the tag's current index digest without pulling, and replace the digest in every `FROM` that uses the tag:

```sh
docker buildx imagetools inspect node:24-slim | grep -m1 '^Digest:'   # the index, not a per-platform manifest
grep -rn '^FROM node:24-slim@' interop/                                # where it's used
```

Check that `MediaType` is an image index (`…image.index…` or `…manifest.list…`) listing `linux/amd64` and `linux/arm64`, then rebuild the images that use it and run the grid.

## Vectors

`vectors/datalayer/run.mjs` runs Datalayer's language-neutral conformance cases against our client and validator ([its README](vectors/datalayer/README.md)). We used to export our own validator fixtures and the mock's tamper rows the same way, as `vectors/validator.json` and `vectors/mock-company.json`; they were removed because nothing consumed them, and the shared vectors repository they were meant to seed was never made. The fixtures and rows themselves are still the tests in `test/validator.test.ts` and `test/mock-company.test.ts`. `vectors/validators/run.mjs` runs our validator and two independent ones over the same documents, the other two in Docker with no network ([its README](vectors/validators/README.md)).
