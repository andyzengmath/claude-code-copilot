# Claude Code via GitHub Copilot

<p align="center">
<img alt="pipeline" src="https://github.com/user-attachments/assets/bdc80db2-97b2-4515-ae13-ef220ba3b21c" width="full"/>
</p>

Route Claude Code through your existing GitHub Copilot access using a local, authenticated Node.js proxy. No Anthropic API key is needed, but **GitHub plan quotas, premium-request allowances, and billing still apply**.

The default transport uses Copilot's native `/v1/messages` endpoint when the account's model capability metadata supports it. An explicit legacy Chat Completions adapter remains available. This is not full Anthropic API parity: supported models and features depend on the upstream account, integrator, and endpoint.

<p align="center">
  <img src="assets/claude-copilot.png" alt="Claude Code via GitHub Copilot" width="full" />
</p>

## Features

- **Native Messages** — Preserves Anthropic request semantics and streaming, subject to actual Copilot support; no automatic replay through another transport.
- **Hosted WebSearch** — Answers Claude Code's `web_search_20250305` requests with one Copilot `/responses` call that runs OpenAI's server-side web search on GPT-6 Luna. Falls back to bounded search emulation through GitHub's own search, Exa/Parallel, and DuckDuckGo.
- **Authenticated local endpoint** — Persistent random API key; loopback binding by default.
- **Docker support** — Loopback-only host publishing, read-only credential mounts, and automatic container restart.
- **Zero runtime dependencies** — Node.js built-ins; no `npm install` needed for the proxy or tests.

## Prerequisites

- GitHub account with Copilot access to the requested model; organization policy may restrict access.
- [Node.js](https://nodejs.org/) **22+**, including for authentication and local-key creation before Docker startup.
- Optional [Docker](https://www.docker.com/) with the `docker compose` plugin.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)
- Bash for the launcher. On Windows, PowerShell setup below does not require Bash.

## Quick Start

### 1. Clone and authenticate

```bash
git clone https://github.com/samarth777/claude-code-copilot.git
cd claude-code-copilot
node scripts/auth.mjs
```

The auth script guides you through GitHub's device-code flow. The OAuth token is stored privately at `~/.claude-copilot-auth.json`, or `COPILOT_AUTH_FILE` if set.

### 2. Start Claude Code

**Bash launcher:**

```bash
./scripts/launch.sh
```

The launcher reads/creates a persistent local API key, verifies a compatible running proxy that proves it holds the same key, or tries Docker before Node. The proof is an HMAC of a fresh nonce, so the launcher never sends its key to a listener that does not already hold it. It waits up to 30 seconds for readiness and cleans up its Node child if startup fails. A ready Node proxy remains available when Claude Code exits so other sessions are not interrupted; use the printed Bash `kill` command to stop it explicitly. Existing proxies and Docker containers are never stopped by the launcher. Export configuration variables before launching; the launcher does not source `.env`.

**Manual Node startup:**

```bash
node scripts/proxy.mjs
```

In another terminal, from the same checkout and using the same credential-path environment:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:${COPILOT_PROXY_PORT:-18080}"
export ANTHROPIC_API_KEY="$(node scripts/proxy.mjs --print-api-key)"
unset ANTHROPIC_AUTH_TOKEN
claude
```

`--print-api-key` explicitly writes only the key to stdout; capture it rather than displaying it. It works without a GitHub auth file and never contacts GitHub. Normal startup does not print the key. Keep both credentials files private and out of version control.

### 3. Select your model

Discover model identifiers through the authenticated catalog. `printf` is a shell builtin, so the key reaches curl through stdin rather than a command line other local users can list:

```bash
printf 'x-api-key: %s\n' "$ANTHROPIC_API_KEY" |
  curl --fail --silent --show-error -H @- "$ANTHROPIC_BASE_URL/v1/models"
```

Use a returned supported identifier with Claude Code's `/model`. The account/integrator catalog is authoritative; an absent model does not establish your plan's entitlements. Aliases only normalize spelling within the **same version**: the proxy never silently upgrades a tier or model version.

The catalog lists Claude models by their Claude API IDs, such as `claude-opus-4-7`, rather than Copilot's dotted IDs, such as `claude-opus-4.7`. Both spellings route to the same model, but use the dashed one. Claude Code recognizes only that form: for a dotted ID it assumes a 200K context window instead of 1M and sends requests in an older shape.

Claude Code v2.1.280 and later start on **Claude Opus 5.5** by default. Its Claude API ID, `claude-opus-5-5`, normalizes to Copilot's `claude-opus-5.5` when your catalog offers it. Earlier Claude Code versions don't support Opus 5.5; run `claude update` to upgrade.

## Docker

Create both host credential files **before** starting the container. The following preserves custom paths already exported in your shell:

```bash
export COPILOT_AUTH_FILE="${COPILOT_AUTH_FILE:-$HOME/.claude-copilot-auth.json}"
export COPILOT_PROXY_KEY_FILE="${COPILOT_PROXY_KEY_FILE:-$HOME/.claude-copilot-proxy-key.json}"
# Run node scripts/auth.mjs first if the auth file does not exist.
export ANTHROPIC_API_KEY="$(node scripts/proxy.mjs --print-api-key)"
docker compose up -d --build proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:${COPILOT_PROXY_PORT:-18080}"
unset ANTHROPIC_AUTH_TOKEN
claude
```

Use absolute host paths for custom credential files. Compose requires both path variables and mounts the files read-only at `/run/secrets/copilot-auth.json` and `/run/secrets/copilot-proxy-key.json`; it does not create missing source files. Never copy credentials into the image.

Inside the container the proxy listens on `0.0.0.0:18080`, but Compose publishes **only** `127.0.0.1:${COPILOT_PROXY_PORT:-18080}`. `COPILOT_PROXY_HOST` only controls direct Node mode, not container publishing. `restart: always` keeps the proxy available when Docker restarts.

Compose reads `.env` for explicitly mapped configuration, including provider API keys. Direct Node mode and the launcher use exported shell variables; when using the launcher, export port and credential paths there too. `.env*` and the default credential filenames are Git-ignored; keep custom credential files outside the checkout. The Docker context allowlist excludes these secrets. After changing configuration or replacing a mounted credential file, recreate **only this service** with `docker compose up -d --force-recreate --no-deps proxy`.

## Windows (PowerShell)

Use Node.js 22+ and the actual `scripts\proxy.mjs` entry point:

```powershell
# First terminal: authenticate and start the proxy.
git clone https://github.com/samarth777/claude-code-copilot.git
cd claude-code-copilot
node scripts\auth.mjs
node scripts\proxy.mjs
```

```powershell
# Second terminal, from the same checkout:
$key = node scripts\proxy.mjs --print-api-key
if ($LASTEXITCODE -ne 0) { throw "Unable to read the local API key" }
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:18080"
$env:ANTHROPIC_API_KEY = $key
$env:ANTHROPIC_AUTH_TOKEN = ""
$env:CLAUDE_CODE_AUTO_MODE_SERVER = "0"
claude
```

If you previously set `ANTHROPIC_API_KEY` to `copilot-proxy` as a user environment variable, the proxy now rejects it with a 401. Store the local key there instead, so new terminals pick it up:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", (node scripts\proxy.mjs --print-api-key), "User")
```

For Docker Desktop, authenticate first, then replace direct proxy startup with:

```powershell
if (!$env:COPILOT_AUTH_FILE) {
    $env:COPILOT_AUTH_FILE = Join-Path $HOME ".claude-copilot-auth.json"
}
if (!$env:COPILOT_PROXY_KEY_FILE) {
    $env:COPILOT_PROXY_KEY_FILE = Join-Path $HOME ".claude-copilot-proxy-key.json"
}
$key = node scripts\proxy.mjs --print-api-key
if ($LASTEXITCODE -ne 0) { throw "Unable to create/read the local API key" }
$env:ANTHROPIC_API_KEY = $key
$env:ANTHROPIC_AUTH_TOKEN = ""
docker compose up -d --build proxy
$port = if ($env:COPILOT_PROXY_PORT) { $env:COPILOT_PROXY_PORT } else { "18080" }
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
claude
```

When using a custom port or host in direct mode, set the same base URL in Claude Code. For wildcard binds, use a reachable local address (`127.0.0.1` for `0.0.0.0`, `[::1]` for `::`), not the wildcard address as the client URL. Exposing direct mode beyond loopback requires your own network access controls and TLS.

## Transports and compatibility

| `COPILOT_TRANSPORT` | Behavior |
|---|---|
| `auto` (default) | Prefers native Messages when advertised; selects Chat only if the catalog advertises that endpoint instead. Selection happens before inference, never as an error fallback. |
| `messages` | Explicitly selects native Messages; the upstream must support the requested model and features. |
| `chat` | Explicit legacy Chat Completions translation; rejects unsupported semantic features instead of dropping them. |

Native mode preserves Anthropic headers and body fields such as thinking, budgets, cache controls, documents, and `output_config`, subject to what the actual upstream supports. It cannot turn a provider-scoped `file_id` into a file accessible to another provider. A forwarded field is not a guarantee of upstream support. Chat mode is intentionally narrower; `COPILOT_FORWARD_REASONING=0` disables only legacy Chat reasoning translation and never overrides native payloads.

There is **no inference replay between transports**, including after upstream errors. Change transports explicitly when needed, and use a compatible model identifier from the catalog.

### Auto mode

Claude Code's auto mode can ask the API to run its permission classifier server-side. Copilot doesn't support that, so Claude Code shows a notice that the session isn't eligible and runs the classifier itself, sending those requests through the proxy as before. `scripts/launch.sh` sets `CLAUDE_CODE_AUTO_MODE_SERVER=0` to skip the notice; set it yourself when you start `claude` another way.

## Web Search

Ordinary Claude Code WebSearch makes nested requests containing the server tool `web_search_20250305`, which Copilot's native Messages endpoint rejects ("The use of the web search tool is not supported"). The proxy answers these requests in one of two ways.

**Hosted search (default).** A search-only request, which is what Claude Code's WebSearch sends, is answered by one Copilot `/responses` call. That call runs OpenAI's server-side `web_search` tool on `WEB_SEARCH_MODEL` (default `gpt-6-luna`), the way Codex searches. The proxy returns the searches as `server_tool_use` and `web_search_tool_result` blocks, with the sources the model consulted, the pages it opened and the pages it cited, and the model's cited answer as text. This replaces two or more Claude generations with one call to a lightweight model: about 3–10 seconds, typically under 10,000 input tokens. The hosted model is always required to search, including when Claude Code sends `tool_choice: auto`, as it does for its 5.5 models. Hosted search applies only when the request:

- declares no client tools and allows at least one search (`max_uses` above 0);
- has text-only system and message content that ends with a user turn, and `max_tokens` of at least 16;
- has no `blocked_domains` (the hosted tool can restrict to `allowed_domains` but cannot exclude domains);
- uses only fields hosted search can honor: `model`, `max_tokens`, `stream`, `system`, `messages`, `tools`, `tool_choice` (not `none`), `metadata`, `thinking` (`disabled` or `adaptive`), `output_config` with only `effort`, and an empty `stop_sequences`. These are the fields Claude Code's nested WebSearch request uses; anything else, such as `temperature` or `output_config.format`, goes to provider search so that it is honored rather than dropped.

The hosted search model, not Claude, writes the search summary that Claude Code passes back to the main model. Its instructions mark web content as untrusted data. The search model must appear in your Copilot catalog with the `/responses` endpoint. Copilot bills the search model's tokens at its own rates. Responses name the search model in an `x-copilot-search-model` header. Because hosted search does not call the requested model, it also works when that model uses the Chat transport.

**Provider search (fallback).** Other requests, `WEB_SEARCH_MODE=providers`, or an unavailable search model use bounded search emulation: native custom tool calls, proxy-run provider searches, and a final Claude synthesis. Each search round may consume additional Copilot requests. Provider search needs the native Messages transport; on the Chat transport, a search that hosted search cannot answer gets HTTP 501. A hosted search also falls back when Copilot returns an error, when the search model completes no search, declines, or relies on a page outside `allowed_domains`, or when its reply is malformed. The fallback happens before any output is sent, and the response reports the tokens of a hosted answer that was received but not used. Hosted search makes one attempt with the `WEB_SEARCH_TIMEOUT_MS` deadline. It counts toward the same concurrency and spacing limits as Claude requests, but a `Retry-After` from the search model pauses only hosted search, never Claude requests. After HTTP 429 or 503 with `Retry-After`, the proxy skips hosted search for that period (one minute after a 429 without it), and after HTTP 401, 403 or 404 for five minutes, using provider search directly.

Search input rules:

- Supply at most one of `allowed_domains` or `blocked_domains`, with up to 100 hostnames. Matching enforces hostname boundaries and normalizes case, punycode, and trailing dots. Schemes, ports, paths, and wildcards are not accepted.
- `user_location` (`{"type": "approximate"}` with optional `city`, `region`, two-letter `country`, and `timezone`) is passed to hosted search. Provider search cannot localize results; it ignores the location and logs a warning.
- Supplying two non-null domain lists, a malformed `user_location`, or a newer/unknown server-search version is explicitly rejected, not guessed. Documented nullable options treat `null` as unset.
- The `search_profile` hint that Claude Code 2.1.303 and later can send is accepted and ignored. Other unrecognized optional tool fields are ignored with one logged warning per distinct set of names, so a new Claude Code release does not break WebSearch.
- `max_uses: 0` disables search without changing a remaining client-tool selection or `none` choice. Requiring a disabled or unavailable tool is contradictory input and returns HTTP 400 before model discovery or SSE starts.

Search emulation uses native **streaming inner generations**, even for nonstreaming clients, to avoid the nonstreaming output-limit regression. Streaming clients receive content, search-result blocks, and pings progressively; nonstreaming clients receive an assembled response. Usage is aggregated across generations, and real stop reasons such as `pause_turn` and `max_tokens` are preserved rather than replaced with a fabricated successful stop.

The logical response shares one `max_tokens` allowance: each continuation receives only the remaining output budget, based on the upstream's reported output usage. No hidden generation starts after that allowance is exhausted; the response stops with `max_tokens`. Manual thinking keeps its requested per-generation budget. If the remaining allowance cannot accommodate the normal manual-thinking constraints, emulation returns an explicit error rather than disabling thinking, increasing the allowance, or assuming an interleaved-thinking exception.

Prior proxy-generated search results remain usable in conversation history even when the current request's tools omit `web_search`.

Provider search tries, in order: GitHub's own web search, the tool GitHub Copilot CLI uses, reached with your Copilot sign-in through `https://api.githubcopilot.com/mcp/`; Exa/Parallel MCP, using the approach in [OpenCode](https://github.com/anomalyco/opencode); Brave and Serper when their keys are set; and DuckDuckGo Lite and Instant Answer. Only GitHub's search receives your Copilot sign-in. `WEBSEARCH_PROVIDER=github`, `exa`, or `parallel` moves that provider to the front; it does not disable the others. GitHub's search may require your organization to allow Copilot web search; when GitHub refuses a search (HTTP 401 or 403), the proxy logs that once, and searches continue with the third-party providers. A provider whose results the domain lists exclude does not end the chain. Configure keys as needed; provider terms, quotas, availability, and charges apply. Unauthenticated endpoints may be throttled or unavailable.

Defaults bound provider searches to two concurrent operations, a 25-second deadline per provider request, a 60-second deadline per search across all providers, and a ten-use request cap; the cap also limits hosted searches. A search that cannot start because the search queue is full is reported to the model as `too_many_requests`, like any other failed search, rather than failing the response. Results are cached **in memory** for five minutes, up to 500 entries and 16 MiB, separately for each Copilot credential; query logging is opt-in via `COPILOT_LOG_SEARCH_QUERIES=1`.

## Privacy and local authentication

Every non-health route requires the persistent local key in `x-api-key` or `Authorization: Bearer <key>`. There is no wildcard CORS access. Public `GET`/`HEAD` requests to `/health` and `/` remain healthy independently of temporary upstream catalog failures; GET returns:

```json
{"status":"ok","provider":"github-copilot","api_key_required":true}
```

With `?nonce=` followed by 32 to 128 lowercase hex characters, the response also includes `key_proof`: an HMAC-SHA256 of the nonce under the local key. The launcher checks it before it sends the key, so a process that occupies the port cannot collect the key or Claude Code's prompts.

OAuth credentials and the local API key are persisted privately on disk. On POSIX, a credential file that other users can read, such as one written by an older version, is restricted to its owner when read. On Windows, keep custom credential paths in a folder only you can read, not one created directly under `C:\`, where every signed-in user can read and modify files by default. Model metadata and query results are cached in memory; query logging is disabled by default, but operational/error logs can still be emitted. Prompts go to GitHub Copilot. Hosted search sends the search request, including Claude Code's search prompt, to Copilot's `/responses` endpoint, where the search model runs OpenAI's web search. Provider search sends queries to GitHub's search first and then to configured or fallback providers. Their data handling policies apply. Do not put secrets in queries, publish credential files, or assume that a local proxy means data stays on your machine.

## Reliability and errors

- Upload, response, and SSE event sizes are bounded. The request timeout covers upstream headers and idle-body/drain waits, not an unconditional wall-clock limit for an actively progressing stream.
- Retries cover explicit **429, 500, 502, 503, and 504** responses only. Admission and dispatch of additional attempts must fit within the retry budget; an already-dispatched response retains its own timeout. Full `Retry-After` delays are honored when affordable or returned to the client, never shortened. Ambiguous network errors, timeouts, and response-body failures are not automatically replayed. Hosted search requests are never retried; provider search is their fallback.
- Client disconnects cancel owned upstream work, queue waits, and search work rather than allowing detached requests to continue.
- Inference concurrency is unlimited by default (`COPILOT_MAX_CONCURRENT_REQUESTS=0`). Setting a positive limit enables bounded admission: 64 queued requests, 64 MiB queued bodies, and a 30-second queue deadline by default. Overflow/deadline failures return errors rather than growing an unbounded queue.
- Before streaming starts, failures use an HTTP status and JSON error envelope. After SSE starts, errors are reported in-stream; clients must inspect error events, not just the initial HTTP status.
- Malformed or truncated tool arguments are reported as protocol errors before a tool block is completed, not converted into executable empty input.

For example, opt in to a four-request concurrency limit and optional spacing:

```bash
COPILOT_MAX_CONCURRENT_REQUESTS=4 COPILOT_MIN_REQUEST_INTERVAL_MS=100 ./scripts/launch.sh
```

## Configuration

Export variables before starting Node or the launcher. Compose explicitly maps the variables below, except host/internal port, which are fixed inside the container as described above. `scripts/config.mjs` validates runtime configuration; `scripts/credentials.mjs` resolves credential paths.

| Variable | Default | Description |
|---|---|---|
| `COPILOT_PROXY_HOST` | `127.0.0.1` | Direct bind address; container always binds `0.0.0.0` |
| `COPILOT_PROXY_PORT` | `18080` | Direct listen / Docker host port; container port stays `18080` |
| `COPILOT_AUTH_FILE` | `~/.claude-copilot-auth.json` | OAuth credential file; explicit host path required for manual Compose |
| `COPILOT_PROXY_KEY_FILE` | `~/.claude-copilot-proxy-key.json` | Local key file; explicit host path required for manual Compose |
| `COPILOT_TRANSPORT` | `auto` | `auto`, `messages`, or explicit `chat` |
| `COPILOT_FORWARD_REASONING` | `1` | Legacy Chat reasoning translation only; `0` opts out |
| `COPILOT_LOG_SEARCH_QUERIES` | `0` | Opt in to query logging with `1` |

### Bounds, retries, and scheduling

| Variable | Default | Description |
|---|---|---|
| `COPILOT_MAX_BODY_BYTES` | `33554432` | Maximum request body (32 MiB) |
| `COPILOT_MAX_RESPONSE_BYTES` | `67108864` | Maximum upstream response (64 MiB) |
| `COPILOT_MAX_SSE_EVENT_BYTES` | `8388608` | Maximum SSE event (8 MiB) |
| `COPILOT_REQUEST_TIMEOUT_MS` | `120000` | Header and idle-body/drain timeout |
| `COPILOT_MAX_RETRIES` | `3` | Retryable HTTP-status retries; `0` disables retries |
| `COPILOT_RETRY_BUDGET_MS` | `30000` | Total retry budget; does not shorten `Retry-After` |
| `COPILOT_MIN_REQUEST_INTERVAL_MS` | `0` | Optional minimum spacing between upstream requests |
| `COPILOT_MAX_CONCURRENT_REQUESTS` | `0` | Unlimited by default; positive values enable an inference limit |
| `COPILOT_MAX_QUEUED_REQUESTS` | `64` | Maximum queued requests when admission is limited |
| `COPILOT_MAX_QUEUE_BYTES` | `67108864` | Maximum retained queued body bytes (64 MiB) |
| `COPILOT_QUEUE_TIMEOUT_MS` | `30000` | Queue wait deadline |
| `COPILOT_HEARTBEAT_INTERVAL_MS` | `15000` | SSE heartbeat interval; `0` disables |

### Search

| Variable | Default | Description |
|---|---|---|
| `WEB_SEARCH_MODE` | `hosted` | `hosted` answers eligible searches with one Copilot `/responses` call; `providers` always uses provider search emulation |
| `WEB_SEARCH_MODEL` | `gpt-6-luna` | Copilot model for hosted search; must list the `/responses` endpoint in your catalog |
| `WEB_SEARCH_CONTEXT_SIZE` | `low` | Hosted search context size: `low`, `medium`, or `high` (more context is slower and uses more tokens) |
| `WEB_SEARCH_REASONING_EFFORT` | `low` | Hosted search model reasoning effort: `low`, `medium`, or `high` |
| `WEBSEARCH_PROVIDER` | *(empty)* | Provider search order: GitHub first, then Exa/Parallel; `github`, `exa`, or `parallel` moves that provider to the front |
| `BRAVE_API_KEY` | *(empty)* | Brave Search API key |
| `SERPER_API_KEY` | *(empty)* | Serper API key |
| `EXA_API_KEY` | *(empty)* | Exa API key, where required by the endpoint |
| `PARALLEL_API_KEY` | *(empty)* | Parallel API key, where required by the endpoint |
| `WEB_SEARCH_MAX_RESULTS` | `5` | Results per query |
| `WEB_SEARCH_MAX_USES_CAP` | `10` | Cap on request search uses |
| `WEB_SEARCH_TIMEOUT_MS` | `25000` | Deadline for the hosted search call and for each provider request |
| `WEB_SEARCH_TOTAL_TIMEOUT_MS` | `60000` | Deadline for one provider search across all fallback providers |
| `WEB_SEARCH_MAX_RESPONSE_BYTES` | `2097152` | Maximum provider response (2 MiB) |
| `WEB_SEARCH_MAX_CONCURRENT` | `2` | Concurrent provider searches |
| `WEB_SEARCH_CACHE_TTL_MS` | `300000` | In-memory result TTL (5 minutes); `0` disables |
| `WEB_SEARCH_CACHE_MAX_ENTRIES` | `500` | In-memory entry limit; `0` disables |
| `WEB_SEARCH_CACHE_MAX_BYTES` | `16777216` | In-memory result byte limit (16 MiB); `0` disables |
| `WEB_SEARCH_MAX_QUERY_BYTES` | `8192` | Maximum query length in bytes |

### Catalog and upstream identity

| Variable | Default | Description |
|---|---|---|
| `COPILOT_MODEL_CACHE_TTL_MS` | `300000` | Credential-scoped model catalog freshness (5 minutes) |
| `COPILOT_MODEL_CACHE_MAX_STALE_MS` | `3600000` | Bounded stale-catalog allowance during upstream failure |
| `COPILOT_MODEL_REQUEST_TIMEOUT_MS` | `3000` | Model discovery request timeout |
| `COPILOT_EDITOR_VERSION` | `vscode/1.99.0` | `Editor-Version` header sent to Copilot |
| `COPILOT_INTEGRATION_ID` | `vscode-chat` | `Copilot-Integration-Id` header sent to Copilot |

## Migration and troubleshooting

- **Upgrading from the old proxy:** the literal `copilot-proxy` API key no longer works, and the old proxy accepts requests without any key, so stop it before starting this version. The launcher detects it and prints these steps.
  - Docker: `docker rm -f claude-copilot-proxy`, then run `./scripts/launch.sh`, or export `COPILOT_AUTH_FILE` and `COPILOT_PROXY_KEY_FILE` as shown under [Docker](#docker) and run `docker compose up -d --build --force-recreate --no-deps proxy`.
  - Node: stop the old `node scripts/proxy.mjs` process, then start the new one.
  - Then capture the generated key with `--print-api-key` and update `ANTHROPIC_API_KEY`.
- **401 from the local proxy:** use the same key file as the running service and send `x-api-key` or Bearer auth. Health is intentionally public and does not validate your key.
- **401 from Copilot:** rerun `node scripts/auth.mjs` with the intended `COPILOT_AUTH_FILE`, then restart your proxy. Do not delete unrelated credentials.
- **Port occupied / incompatible service:** identify the owning process/container and stop or restart only that resource, or choose a different `COPILOT_PROXY_PORT`. The launcher never kills a shared proxy or restarts unrelated Docker services.
- **Unknown model / unsupported feature:** inspect authenticated `/v1/models`, select an available identifier, and check the transport restrictions above. No automatic tier/version substitution is performed.
- **429, queue overload, or timeout:** inspect the returned error and `Retry-After`, reduce parallelism, or adjust documented bounds. Raising retries cannot safely repair ambiguous network failures.

## Tests

Run all suites using Node's built-in test runner on Node.js 22+:

```bash
npm test
```

No dependency installation, home auth token, or real provider calls are required. Tests use injected auth, temporary credentials, local fixtures, and ephemeral ports. The aggregate command explicitly lists the suites so Windows does not depend on shell glob expansion. Proxy CLI tests cover real `--print-api-key` and startup with temporary credentials; launcher tests use Bash (Git Bash on Windows) and skip if Bash is unavailable. CI runs the suites on Node.js 22, 24, and 26 on Linux and Windows without installing Claude Code, plus an isolated Ubuntu Docker smoke test with fixture credentials.

### Optional installed-client fixtures

`scripts/test-claude-client.mjs` runs three offline integration fixtures against an already installed Claude Code binary when `CLAUDE_CODE_TEST_BINARY` is set: ordinary inference, WebSearch through provider search, and WebSearch through hosted search. Otherwise they explicitly skip, including in CI. These fixtures use the local proxy with injected model/search responses, not real Copilot or search-provider APIs.

Run just these fixtures with a binary available on your PATH:

```bash
CLAUDE_CODE_TEST_BINARY="$(command -v claude)" node --test scripts/test-claude-client.mjs
```

```powershell
$env:CLAUDE_CODE_TEST_BINARY = (Get-Command claude.exe -CommandType Application -ErrorAction Stop).Source
node --test scripts\test-claude-client.mjs
Remove-Item Env:CLAUDE_CODE_TEST_BINARY
```

Alternatively, set the variable to the full path of your installed executable. The ordinary inference fixture uses `--bare`; the WebSearch fixture deliberately uses non-bare mode to exercise Claude Code's actual nested search request, with hooks and MCP disabled. Setting this variable also enables the fixtures during `npm test`; leave it unset for the default dependency-free run.

## License

MIT
