---
description: Check the GitHub Copilot proxy setup and show how to start Claude Code through it
allowed-tools: Bash(node --version), Bash(test -s *)
---

Help the user start Claude Code through the claude-code-copilot proxy in `${CLAUDE_PLUGIN_ROOT}`. Never read, print or copy a credential: do not show the contents of `~/.claude-copilot-auth.json`, `~/.claude-copilot-proxy-key.json` or the files that `COPILOT_AUTH_FILE` and `COPILOT_PROXY_KEY_FILE` name, and do not run `scripts/proxy.mjs --print-api-key` yourself.

1. Run `node --version`. If Node.js is missing or older than 22, tell the user to install Node.js 22 or newer, and stop.

2. Check for a saved GitHub sign-in without reading it. Claude Code may ask before it runs this command, because the command contains a variable; it only tests that the file exists and is not empty:
   ```
   test -s "${COPILOT_AUTH_FILE:-$HOME/.claude-copilot-auth.json}"
   ```
   Exit status 0 means the user is signed in. Otherwise, ask the user to run this in their own terminal, complete GitHub's device sign-in, and tell you when it is done; then check again:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/auth.mjs"
   ```

3. Tell the user to exit this session and start Claude Code from a terminal with the launcher. It reuses or starts the proxy (Docker if available, otherwise Node.js) and gives Claude Code the local key:
   ```
   "${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh"
   ```
   For an alias, they can add `alias claude-copilot='"${CLAUDE_PLUGIN_ROOT}/scripts/launch.sh"'` to `~/.bashrc` or `~/.zshrc`, replacing any older `claude-copilot` alias.

4. Without Bash, for example in PowerShell, point the user to the manual steps in `${CLAUDE_PLUGIN_ROOT}/README.md`. In short, from `${CLAUDE_PLUGIN_ROOT}`: run `node scripts/proxy.mjs` in one terminal; in another, set `ANTHROPIC_BASE_URL` to `http://127.0.0.1:18080`, set `ANTHROPIC_AUTH_TOKEN` to the output of `node scripts/proxy.mjs --print-api-key`, remove `ANTHROPIC_API_KEY`, and run `claude`.

Be concise. Never suggest `ANTHROPIC_API_KEY=copilot-proxy` or `http://localhost:18080` from older instructions: the proxy rejects that key, and it listens on `127.0.0.1`.
