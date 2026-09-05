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

for dependency in node curl claude; do
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

healthy() {
    if ! curl --noproxy '*' --fail --silent --connect-timeout 1 --max-time 2 \
        --max-filesize 4096 "$1/health" 2>/dev/null |
        node -e '
            let text = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", chunk => { text += chunk; if (text.length > 4096) process.exit(1); });
            process.stdin.on("end", () => {
                try {
                    const h = JSON.parse(text);
                    process.exit(h.status === "ok" && h.provider === "github-copilot" && h.api_key_required === true ? 0 : 1);
                } catch { process.exit(1); }
            });
        '; then
        return 1
    fi
    local status
    # A null Messages body fails locally after key validation, without a Copilot call.
    if ! status="$(curl --noproxy '*' --silent --connect-timeout 1 --max-time 2 \
        --output /dev/null --write-out '%{http_code}' --request POST \
        --header "x-api-key: $API_KEY" --header 'content-type: application/json' \
        --data 'null' "$1/v1/messages" 2>/dev/null)"; then
        return 1
    fi
    [ "$status" = "400" ]
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
    echo "✗ Port $PORT is already in use by an incompatible service or a proxy with a different local key." >&2
    echo "  Restart that proxy with this version and its local key, or choose COPILOT_PROXY_PORT." >&2
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

ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_API_KEY="$API_KEY" \
ANTHROPIC_AUTH_TOKEN="" \
claude "$@"
