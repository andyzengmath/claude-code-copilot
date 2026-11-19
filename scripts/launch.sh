#!/usr/bin/env bash

# Reuse a compatible proxy, or start Docker / a reusable Node process, then Claude Code.
# Usage: ./scripts/launch.sh [claude-code-args...]

set -euo pipefail
# Shell tracing would expose the key when it is captured or passed to the client.
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${COPILOT_PROXY_PORT:-18080}"
HOST="${COPILOT_PROXY_HOST:-127.0.0.1}"
PROXY_PID=""
# Keep Compose's .env interpolation and direct Node startup on the probed address.
export COPILOT_PROXY_PORT="$PORT" COPILOT_PROXY_HOST="$HOST"

for dependency in node claude; do
    if ! command -v "$dependency" > /dev/null 2>&1; then
        echo "✗ Required command not found: $dependency" >&2
        exit 1
    fi
done
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    echo "✗ Node.js 22 or newer is required." >&2
    exit 1
fi

# Resolve defaults through the same helper as auth/proxy (also correct for Git Bash).
credential_path() {
    node --input-type=module -e '
        import { resolve } from "node:path";
        import { pathToFileURL } from "node:url";
        const helpers = await import(pathToFileURL(process.argv[1]));
        process.stdout.write(resolve(helpers[process.argv[2]]()));
    ' "$SCRIPT_DIR/credentials.mjs" "$1"
}
if ! COPILOT_AUTH_FILE="$(credential_path authFilePath)" ||
   ! COPILOT_PROXY_KEY_FILE="$(credential_path proxyKeyFilePath)"; then
    echo "✗ Unable to resolve credential file paths." >&2
    exit 1
fi
export COPILOT_AUTH_FILE COPILOT_PROXY_KEY_FILE

# Create the key before Docker starts: both credential files are read-only mounts.
if ! API_KEY="$(node "$SCRIPT_DIR/proxy.mjs" --print-api-key)" || [ -z "$API_KEY" ]; then
    echo "✗ Unable to read/create the local proxy API key." >&2
    exit 1
fi
if [ ! -f "$COPILOT_AUTH_FILE" ]; then
    echo "✗ Not authenticated. Run authentication first:" >&2
    printf '  node %q\n' "$SCRIPT_DIR/auth.mjs" >&2
    exit 1
fi

CLIENT_HOST="$HOST"
case "$HOST" in
    0.0.0.0) CLIENT_HOST=127.0.0.1 ;;
    ::|'[::]') CLIENT_HOST=::1 ;;
esac
URL_HOST="$CLIENT_HOST"
if [[ "$URL_HOST" == *:* && "$URL_HOST" != \[*\] ]]; then URL_HOST="[$URL_HOST]"; fi
DIRECT_BASE_URL="http://$URL_HOST:$PORT"
DOCKER_BASE_URL="http://127.0.0.1:$PORT"
BASE_URL="$DIRECT_BASE_URL"

LEGACY_PROXY=false

# The proxy proves that it holds our key by answering a fresh nonce with an
# HMAC under the key, so the key is never sent to, and Claude Code is never
# pointed at, a listener that does not already hold it. The key reaches node
# through its environment: other local users can read command lines, not it.
healthy() {
    local status=0
    PROBE_URL="$1" PROXY_API_KEY="$API_KEY" node -e '
        const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
        const http = require("node:http");
        setTimeout(() => process.exit(1), 4500).unref();
        const get = (path) => new Promise((resolve) => {
            const request = http.get(new URL(path, process.env.PROBE_URL), { timeout: 2000, agent: false }, (response) => {
                let text = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => { text += chunk; if (text.length > 4096) process.exit(1); });
                response.on("end", () => {
                    let body = null;
                    try { body = JSON.parse(text); } catch {}
                    resolve({ status: response.statusCode, body });
                });
            });
            request.on("timeout", () => request.destroy());
            request.on("error", () => process.exit(1));
        });
        (async () => {
            const nonce = randomBytes(16).toString("hex");
            let { status, body } = await get(`/health?nonce=${nonce}`);
            // Proxies from before the local API key answer only the exact path /health.
            if (status === 404) ({ status, body } = await get("/health"));
            if (status !== 200 || body?.status !== "ok" || body.provider !== "github-copilot") process.exit(1);
            if (body.api_key_required !== true) process.exit(2);
            const expected = createHmac("sha256", process.env.PROXY_API_KEY).update(`claude-code-copilot health ${nonce}`).digest();
            const proof = Buffer.from(typeof body.key_proof === "string" ? body.key_proof : "", "hex");
            process.exit(proof.length === expected.length && timingSafeEqual(proof, expected) ? 0 : 1);
        })();
    ' 2>/dev/null || status=$?
    if [ "$status" = 2 ]; then LEGACY_PROXY=true; fi
    return "$status"
}

# Detect an occupied port even when HTTP health is broken, old, or not HTTP at all.
port_open() {
    node -e '
        const net = require("node:net");
        const socket = net.connect({host: process.argv[1].replace(/^\[|\]$/g, ""), port: Number(process.argv[2])});
        socket.setTimeout(1000);
        socket.on("connect", () => { socket.destroy(); process.exit(0); });
        socket.on("error", () => process.exit(1));
        socket.on("timeout", () => { socket.destroy(); process.exit(1); });
    ' "$1" "$PORT" 2>/dev/null
}
incompatible_service() {
    if [ "$LEGACY_PROXY" = true ]; then
        echo "✗ Port $PORT is used by an older claude-code-copilot proxy that accepts requests without an API key." >&2
        echo "  Stop it, then run this launcher again to start the current version:" >&2
        echo "    Docker:  docker rm -f claude-copilot-proxy" >&2
        echo "    Node:    stop the node scripts/proxy.mjs process that listens on port $PORT" >&2
    else
        echo "✗ Port $PORT is already in use by an incompatible service or a proxy with a different local key." >&2
        echo "  Restart that proxy with this version and its local key, or choose COPILOT_PROXY_PORT." >&2
    fi
    echo "  No existing process or container has been stopped." >&2
}
wait_ready() {
    local deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        if [ -n "$PROXY_PID" ] && ! kill -0 "$PROXY_PID" 2>/dev/null; then return 1; fi
        if healthy "$BASE_URL"; then return 0; fi
        sleep 0.2
    done
    return 1
}
cleanup() {
    if [ -n "$PROXY_PID" ]; then
        # Only a failed/incomplete startup is eligible; a ready proxy may be shared.
        if kill -0 "$PROXY_PID" 2>/dev/null; then
            echo "Stopping launcher-owned proxy..."
            kill "$PROXY_PID" 2>/dev/null || true
            for ((i = 0; i < 20; i++)); do
                if ! kill -0 "$PROXY_PID" 2>/dev/null; then break; fi
                sleep 0.1
            done
            if kill -0 "$PROXY_PID" 2>/dev/null; then kill -KILL "$PROXY_PID" 2>/dev/null || true; fi
        fi
        wait "$PROXY_PID" 2>/dev/null || true
        PROXY_PID=""
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if healthy "$BASE_URL"; then
    echo "✓ Reusing compatible proxy on port $PORT"
elif port_open "$CLIENT_HOST"; then
    incompatible_service
    exit 1
else
    DOCKER_READY=false
    if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1 &&
       docker compose version > /dev/null 2>&1; then
        BASE_URL="$DOCKER_BASE_URL"
        if healthy "$BASE_URL"; then
            DOCKER_READY=true
            echo "✓ Reusing compatible proxy on port $PORT"
        elif port_open 127.0.0.1; then
            incompatible_service
            exit 1
        else
            echo "Starting proxy via Docker..."
            if (cd "$PROJECT_DIR" && docker compose up -d --build --no-deps proxy); then
                if wait_ready; then
                    DOCKER_READY=true
                    echo "✓ Proxy running in Docker"
                else
                    echo "✗ Docker proxy did not become ready within 30 seconds." >&2
                fi
            else
                echo "✗ Docker startup failed." >&2
            fi
        fi
    fi
    if [ "$DOCKER_READY" != true ]; then
        # A failed Docker start may still own the published port. Do not race it.
        if port_open 127.0.0.1 || port_open "$CLIENT_HOST"; then
            incompatible_service
            exit 1
        fi
        BASE_URL="$DIRECT_BASE_URL"
        echo "Starting proxy with Node.js..."
        node "$SCRIPT_DIR/proxy.mjs" &
        PROXY_PID=$!
        if ! wait_ready; then
            echo "✗ Proxy failed to start or did not become ready within 30 seconds." >&2
            exit 1
        fi
        echo "✓ Proxy started (PID: $PROXY_PID)"
        echo "  It remains available for other sessions. Stop it from Bash with: kill $PROXY_PID"
        PROXY_PID=""
    fi
fi

echo "Starting Claude Code via Copilot..."
echo ""

# Interactive Claude Code uses ANTHROPIC_API_KEY only after a prompt that
# defaults to No; ANTHROPIC_AUTH_TOKEN needs no prompt and overrides a claude.ai
# login. An inherited API key would bring the prompt back, so it is unset.
ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$API_KEY" \
CLAUDE_CODE_AUTO_MODE_SERVER="${CLAUDE_CODE_AUTO_MODE_SERVER:-0}" \
env -u ANTHROPIC_API_KEY claude "$@"
