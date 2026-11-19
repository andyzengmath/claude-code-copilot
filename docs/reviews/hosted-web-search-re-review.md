# Re-review: hosted web search, its follow-up, and earlier fixes

Reviewed on 2026-11-18 and 19 at `9458250`: `main` (`43ea788`, PR #11) plus PR #12. The fixes are in PR #13 (`fix/re-review`).

## Method

The pipeline was ql-deep-review at its CRITICAL tier, as for the [first review](hosted-web-search-deep-review.md). The risk score was about 77: 36 files (+10.0K/−2.7K lines), credential and authentication code, and AI-assisted commits.

- **Seven reviewers.** Six had not seen the code before: correctness, security, tests (with mutation testing), architecture, an adversarial critic, and a second critic on a different model family. A synthesizer then merged their reports.
- **A ledger of every previously observed issue.** About 65 items from five sources, each verified independently by a reviewer other than the one who raised it, with code reading, pinning tests, deliberate breaks and probes:
  - the first deep review (DR-1 to DR-34, R-1 to R-6);
  - the [2026-10-01 review](../review-2026-10-01.md) (#1 to #15);
  - the five notes left open in the PR #10 review;
  - the issues found on the original `main`;
  - problems seen in use: an interactive 401 from Claude Code, upstream issue samarth777/claude-code-copilot#2, and `localhost` base URLs.
- **Evidence checks.** Every finding cites a file, a line range and an evidence type, and none cites a file, line or symbol that does not exist at the reviewed commit. None were suppressed.
- **Client version.** Claude Code auto-updated from 2.1.303 to 2.1.328 during the review. All client evidence is from 2.1.328.

## Verdict

**Before fixes: REQUEST_CHANGES.**
- Three reviewers voted REQUEST_CHANGES and three APPROVE_WITH_COMMENTS. The synthesizer's risk score was 45/100.
- 37 findings after merging: 1 high, 12 medium, 20 low and 4 informational. None is critical.
- Seven previously fixed items were only partly fixed, and two problems seen in use were unresolved.

**After fixes: APPROVE.** In a confirmation round, each reviewer re-checked its own findings at `e884685`, and its fixes, with deliberate breaks and probes.
- The security reviewer, the test engineer and the critic approved.
- The architect, the correctness reviewer and the cross-provider critic approved with one comment each. All four comments are fixed:
  - **`9b37f4e`:** a queue wait past the hosted deadline paused hosted search, though `/responses` was never sent.
  - **`3a447c1`:** failures before inference, such as a catalog outage, were not logged.
  - **`ac4dc51`:** one README rule still rejected two non-null domain lists.
  - **`ad0dd5f`:** one OAuth test waited 10 seconds.
- Every partial or unresolved ledger item is resolved, except the two accepted residuals, which are now documented.

## Ledger

| Source | Items | Result at `9458250` | Now |
|---|---|---|---|
| First deep review | DR-1 to DR-34, R-1 to R-6 | 34 resolved; partial: DR-4, DR-10, DR-11, DR-19, DR-25, R-5 | All resolved |
| 2026-10-01 review | #1 to #15 | 14 resolved; partial: #8 (a long non-streaming reply was still discarded) | All resolved |
| PR #10 notes | 5 | Resolved; two had no test | Tests added |
| Original `main` issues | 5 | Resolved | — |
| Seen in use | 5 | `localhost` works. Unresolved: the interactive 401 and issue #2. Accepted residuals: the health proof is not bound to the address; the installed-client tests do not run in CI | 401 and issue #2 resolved; `[::1]` held (S-8); residuals documented |

## Findings and fixes

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | High | The launcher and README passed the key as `ANTHROPIC_API_KEY`, which interactive Claude Code uses only after a prompt that defaults to No; then the proxy got the claude.ai login (401), and a first run showed the login screen (issue #2) | Fixed `c569542`, `868e736` |
| S-2 | Medium | `commands/setup-copilot.md` had Claude run `cat` on the GitHub token, with Bash pre-approved | Fixed `1aa9376` |
| S-3 | Medium | Proxy 401s carried no `x-should-retry: false`, so Claude Code retried for about 3 minutes; a rejected GitHub sign-in looked like a wrong local key | Fixed `a1c4ef6`, `c644c41` |
| S-4 | Medium | An empty companion domain list, which Claude Code sends, was rejected with 400 | Fixed `5680e7f` |
| S-5 | Medium | Provider results were cut to the result limit before domain filtering | Fixed `a7c6dab` |
| S-6 | Medium | A truncated hosted answer could skip the completed-search check (DR-4) | Fixed `4c7304f` |
| S-7 | Medium | The hosted deadline was an idle timeout that a slow body kept extending (DR-11) | Fixed `a17bed0` |
| S-8 | Medium | Only `127.0.0.1` was bound, so another local user could take `[::1]` and receive the key and prompts of `localhost` clients | Fixed `738f289` |
| S-9 | Medium | Hosted SSE delta types were unpinned (DR-19) | Tests `5480ab3` |
| S-10 | Medium | The installed-client test never checked the WebSearch result (DR-10) | Tests `6887c38` |
| S-11 | Medium | Release of the admission slot was unpinned for searches | Tests `96f1ded` |
| S-12 | Medium | Upstream retry rules were unpinned, and `x-should-retry: false` from Copilot was ignored | Fixed `65ee446`, `e122c20` |
| S-13 | Medium | A non-streaming reply longer than the request timeout was discarded as 504 (#8) | Fixed `42a5544` |
| S-14 | Low | Two provider deadline tests flaked under load | Fixed `48209f2` |
| S-15 | Low | Hosted search accepted a `tool_choice` naming an undeclared tool | Fixed `da4bf13` |
| S-16 | Low | A legacy 0644 auth file stayed readable on the Docker path (DR-25) | Fixed `c2933c6` |
| S-17 | Low | A hosted timeout did not pause hosted search | Fixed `592063a` |
| S-18 | Low | Hosted pause durations were unpinned (R-5) | Tests `592063a` |
| S-19 | Low | The launcher's key-off-argv rule and the warning-set bound were unpinned | Tests `a77ad5a`, `c163790` |
| S-20 | Low | The health proof can be relayed to another proxy that holds the same key | Accepted; README: run one proxy per key (`0efb053`) |
| S-21 | Low | A credential read failure was a silent 500, and failures before inference, such as a catalog outage, were not logged | Fixed `c644c41`, `3a447c1` |
| S-22 | Low | Model names could carry terminal escape sequences into logs | Fixed `9c75f12` |
| S-23 | Low | Three surviving mutations in search and Chat translation | Tests `11d5d13`, `c163790` |
| S-24 | Low | No test or job timeouts in CI | Fixed `d2fa615` |
| S-25 | Low | Streaming safeguards were unpinned | Tests `0663144` |
| S-26 | Low | The installed-client tests wrote to the real `~/.claude` | Fixed `6887c38` |
| S-27 | Low | Non-Anthropic upstream error bodies, such as HTML, were relayed raw | Fixed `1b4ae3a` |
| S-28 | Low | Defaults are restated in Compose and the README without a check | Deferred |
| S-29 | Low | The README's dotted-ID warning was stale for 2.1.328 | Fixed `0efb053` |
| S-30 | Low | Provider-search streams start before the first generation, so an upstream 429 arrives in the stream | Deferred |
| S-31 | Low | The Docker upgrade steps ran Compose before the key file existed | Fixed `0efb053` |
| S-32 | Low | Auto mode depends on a client fallback that Claude Code says it will remove | Documented `0efb053`, `7d50fc5` |
| S-33 | Low | The admission gate's cooldown is shared by all models, and it paused hosted search | Hosted search no longer pauses on it or on a queue wait (`592063a`, `9b37f4e`); per-model cooldown deferred |
| S-34 | Info | Bisecting across PR #8 needs a recipe | See below |
| S-35 | Info | The container ran as root with default capabilities | Fixed `3a522ce` |
| S-36 | Info | A third search backend would need edits in five places | Deferred |
| S-37 | Info | Search history keeps tool blocks after the tools are removed | Not a defect: Copilot accepts it (live, Opus 5.5 and Haiku 4.5) |

Also fixed while verifying: an OAuth test whose real 1-second deadline a credential read could exceed on a loaded machine (`e884685`, `ad0dd5f`; #13).

### Decisions

Reviewers disagreed on three points. PR #13 takes the safer option in each:
1. **A GitHub token that Copilot rejects** returns 502 with "run node scripts/auth.mjs", so a 401 from the proxy always means the local key (the architect's option). The alternative was a 401 with `x-should-retry: false` (the critic's).
2. **A truncated hosted answer without a completed search** falls back to provider search, so an unsearched answer is never presented as search results (the cross-provider critic's option).
3. **The proxy also holds `[::1]`** on its port (the security reviewer's option), because `localhost` clients prefer `[::1]` when both addresses listen. Docker publishes only `127.0.0.1`, so the README tells Docker users to use `http://127.0.0.1:<port>`.

### Deferred

- **Per-model cooldown (S-33):** first establish whether Copilot rate-limits per model.
- **A third search backend (S-36):** refactor when one is planned.
- **Provider-search stream start (S-30):** start the stream only after the first generation is accepted, so that a 429 keeps its status and `Retry-After`.
- **One source of defaults (S-28):** add a check that Compose and the README match `readConfig({})`.
- **Binding the health proof to the port (S-20):** the Docker port mapping makes this a launcher change too.
- **An optional CI job with a pinned Claude Code**, so the installed-client tests also run in CI.

### Bisecting across PR #8 (S-34)

`git bisect run npm test` gives false failures on commits before two test fixes. Use Node 22 or 24, and skip the commits before `ea9fee0` (OAuth test timing, #13) and before `365016b` (the Windows ACL test on Node 26) with `git bisect skip`.

## Verification

**Test suite at `ad0dd5f`:**
- **Node 26.13 with the installed Claude Code 2.1.328:** 340 tests, 338 pass, 2 skipped (POSIX-only), 0 fail.
- **Node 22.23 and 24.22:** 335 pass, 5 skipped (the installed-client tests without the binary, and the POSIX-only tests), 0 fail.
- **A known Windows exception:** "readers never observe partial JSON during replacements" can fail when the machine is saturated, because a virus scanner holds the freshly written file while it is being renamed. It fails the same way on `9458250`.

**Tests that detect the fixes:** each new test fails when its fix is reverted or deliberately broken.
- In the confirmation round, the test engineer's 46 deliberate breaks were caught 40 times. The 6 that survived have little or no effect.
- With 16 processes saturating the CPU, the provider deadline tests failed 0 times in 120 runs, against 5 before.

**CI:** passes on Ubuntu and Windows with Node 22, 24 and 26, and so does the Docker smoke test, for `e884685`. The smoke test now also asserts the hardened container: a read-only root filesystem, only `CAP_DAC_OVERRIDE` effective, and `NoNewPrivs`.

**Live against Copilot at `ad0dd5f`:** eight scenarios pass.
- **Hosted search:** streaming; JSON with `allowed_domains`; and the Chat transport with `user_location`.
- **Provider search:** `blocked_domains`; `allowed_domains`; a missing search model; and GitHub only, with `WEB_SEARCH_THIRD_PARTY=0`.
- **Plain requests:** JSON, streaming and token counting.

**Real Claude Code 2.1.328 with `ANTHROPIC_AUTH_TOKEN`:** a plain prompt returns OK, and WebSearch is answered by one hosted GPT-6 Luna search that cites nodejs.org/en/download.

**Reviewers' runs of the interactive Claude Code client** used temporary configuration and dummy keys.
- **Fixed launcher:** with a key previously answered "No", an inherited `copilot-proxy` key and a claude.ai login, there is no prompt, and the reply arrives. The old launcher lines produce the reported 401.
- **Fresh install:** first-run setup goes from the theme picker onward with no login screen.
- **Retries:** a wrong key, and a GitHub sign-in that Copilot rejects, now each end after 1 request instead of 11 over more than three minutes.
