# Deep review: hosted web search (PR #11)

Reviewed on 2026-11-18. PR #11 contains three layers on top of `main` (`ed0e1b4`): the PR #8 native gateway, the fixes from the [2026-10-01 review](../review-2026-10-01.md), and hosted web search.

- **Head reviewed:** `3bfea44`
- **Fix commits:**
  - `902548c` hosted and provider search
  - `a169a44` launcher key proof
  - `d9058c7` credentials and SSE
  - `0b464f4` re-review findings
  - `bcbd634` confirmation-round finding
- **Merged:** with a merge commit, `43ea788`, so the commits stay bisectable (DR-32).
- **Follow-up:** PR #12 resolves the deferred findings; see [Follow-up](#follow-up-pr-12).
- **Re-review:** a [re-review](hosted-web-search-re-review.md) found DR-4, DR-10, DR-11, DR-19, DR-25 and R-5 only partly fixed; PR #13 completes them.

## Method

The pipeline was ql-deep-review at its CRITICAL tier. The risk score was about 79, because the PR touches credentials and authentication, changes 35 files (+8.7K/−2.7K lines), and was written with AI assistance.

Six reviewers worked in parallel, read-only and offline. Each one reproduced its findings against the worktree using injected fixtures:

- correctness;
- security;
- test quality, using mutation testing: 42 deliberate breaks;
- an adversarial critic;
- architecture;
- a second critic running on a different model family (GPT-6 Astra), so the findings do not all come from one model.

A synthesis pass then validated every finding against the schema; none were suppressed. It checked that each cited file, line range and symbol exists at `3bfea44` and found no invented references. It merged the 50 raw findings into 34 root causes, and resolved three conflicts between reviewers (listed below).

**Two review rounds followed the fixes:**
1. Each reviewer re-checked its own findings against `d9058c7`.
2. The reviewers who reported new issues in that round confirmed the fixes in `0b464f4`. The one issue found in that confirmation round was fixed in `bcbd634` and confirmed by the reviewer who raised it.

Two facts the fixes depend on were checked directly:

- **Request shape.** The installed Claude Code 2.1.303 sent its nested WebSearch request to a local fixture for six model IDs. The captured shape is described under DR-2 and DR-4.
- **User location.** A live Copilot `/responses` call confirmed that the hosted `web_search` tool accepts `user_location` and that it localizes the results.

## Verdict

**Before fixes: REQUEST_CHANGES.**
- No blockers.
- One high finding (DR-1), which four reviewers found independently.
- 14 medium, 14 low and 5 informational findings.

**After the first round of fixes (`d9058c7`):**
- Every original high and medium finding was confirmed resolved, except DR-6. The cross-provider critic marked DR-6 partial, because its fix introduced R-1.
- Five reviewers voted APPROVE_WITH_COMMENTS.
- The cross-provider critic voted REQUEST_CHANGES for R-1, a new medium issue.
- Four other reviewers reported four low issues introduced by the fixes (R-2 to R-5).

All five are fixed in `0b464f4`.

**Confirmation of `0b464f4`:**
- Four of the five reviewers who reported new issues voted APPROVE: the cross-provider critic, the architect, the adversarial critic and the test engineer. The test engineer re-ran five deliberate breaks of the pause and gate code, and all were caught.
- The correctness reviewer confirmed R-2 but found one new low issue in the R-1 fix (R-6). It is fixed in `bcbd634`.

**Final: APPROVE_WITH_COMMENTS.**
- The correctness reviewer confirmed the R-6 fix and voted APPROVE, so five reviewers approve.
- The security reviewer approves with comments; its only open item is the accepted DR-28 deferral.
- No critical, high or medium finding remains open.
- What remained were deferrals: one low finding (DR-28), two partial refactors (DR-26, DR-30), and two informational items (DR-31, DR-32). PR #12 resolves them; see [Follow-up](#follow-up-pr-12).

## Findings

Severity is the highest any source reviewer gave that the evidence supports. "Fixed" means a test now pins the behavior. Each of these tests fails on the code before the fix, or on a targeted mutation of the guarded code.

| ID | Severity | Finding | Source findings | Status |
|---|---|---|---|---|
| DR-1 | High | Hosted search shared the Copilot gate, retries and cooldown; a 429 from the search model blocked the fallback and all Claude traffic | CODE-REVIEWER-1, TEST-ENGINEER-1, ARCHITECT-1, CRITIC-1 | Fixed `902548c`, refined `0b464f4` |
| DR-2 | Medium | Eligibility was a deny-list, so `stop_sequences`, `temperature`, `output_config.format` and prefills were silently dropped | CROSS-PROVIDER-3, ARCHITECT-2, CRITIC-4 | Fixed `902548c` |
| DR-3 | Medium | After a fatal error, sibling searches could still emit blocks | CROSS-PROVIDER-5 | Fixed `902548c` |
| DR-4 | Medium | Failed, absent or refused hosted searches counted as success; `auto` choice on 5.5 models | CROSS-PROVIDER-1, CRITIC-2, CODE-REVIEWER-5 | Fixed `902548c` |
| DR-5 | Medium | The provider chain stopped before domain filtering | CROSS-PROVIDER-4, CODE-REVIEWER-6 | Fixed `902548c`, refined `0b464f4` |
| DR-6 | Medium | Hosted results dropped citation-only and page-read URLs | CROSS-PROVIDER-2, TEST-ENGINEER-11 | Fixed `902548c`, refined `0b464f4` |
| DR-7 | Medium | Stream-failure guards for search generation and Chat were untested | TEST-ENGINEER-2 | Tests added `902548c` |
| DR-8 | Medium | The "versions are not substituted" 400 was never tested | TEST-ENGINEER-3 | Test added `902548c` |
| DR-9 | Medium | The launcher put the API key on curl's command line | SECURITY-1 | Fixed `a169a44` |
| DR-10 | Medium | Real Claude Code was never run against hosted output | TEST-ENGINEER-5, CRITIC-5 | Hosted fixture added `902548c` |
| DR-11 | Medium | Hosted wiring was unpinned, and its header assertions were vacuous | TEST-ENGINEER-6 | Tests added `902548c` |
| DR-12 | Medium | The GitHub-first provider wiring was never exercised | TEST-ENGINEER-4 | Test added `902548c` |
| DR-13 | Medium | The native-transport 501 ran before hosted search, a regression from `main` for Chat-transport models | ARCHITECT-3, CODE-REVIEWER-2, CRITIC-3, TEST-ENGINEER-9 | Fixed `902548c` |
| DR-14 | Medium | The forwarded custom tool shape was not pinned (issue #5) | TEST-ENGINEER-7 | Test added `902548c` |
| DR-15 | Medium | A rejection from the search queue aborted the whole response | ARCHITECT-4 | Fixed `902548c` |
| DR-16 | Low | Unknown field names were logged raw and kept forever | SECURITY-3, CODE-REVIEWER-7, ARCHITECT-6 | Fixed `902548c` |
| DR-17 | Low | Hosted text deltas could split a UTF-16 surrogate pair | CODE-REVIEWER-4 | Fixed `902548c` |
| DR-18 | Low | Search cache keys omitted the credential | SECURITY-9, ARCHITECT-7 | Fixed `902548c` |
| DR-19 | Low | Most deliberate breaks in `hosted-search.mjs` went undetected | TEST-ENGINEER-8 | Tests added `902548c` |
| DR-20 | Low | The start and stop events of parallel results interleaved | CODE-REVIEWER-8 | Fixed `902548c` |
| DR-21 | Low | An unterminated final SSE frame corrupted the error event | CODE-REVIEWER-9 | Fixed `d9058c7` |
| DR-22 | Low | The `site:` restriction and the `/v1/models` filter were untested | TEST-ENGINEER-10 | Tests added `902548c` |
| DR-23 | Low | A hosted answer that was received but rejected discarded its usage | CODE-REVIEWER-3 | Fixed `902548c`; searches counted `20a3fce` |
| DR-24 | Low | The launcher sent the key to anything that mimicked `/health` | SECURITY-2 | Fixed `a169a44` |
| DR-25 | Low | Token files written by `main` (often mode 0644) were not re-permissioned | SECURITY-4 | Fixed `d9058c7` (POSIX) |
| DR-26 | Low | The `hostedSearch` closure forced a `started` handshake | ARCHITECT-5 | Fixed `902548c`, `ff9f96a`, `05858f7` |
| DR-27 | Low | `allowed_domains` was not enforced on page reads and citations | SECURITY-5 | Fixed `902548c` |
| DR-28 | Low | Windows credential temp files briefly have inherited ACLs | SECURITY-6 | Fixed `ae8c1ea` |
| DR-29 | Low | A Docker upgrade left the keyless container running | CRITIC-6 | Fixed `a169a44`, refined `0b464f4` |
| DR-30 | Info | Provider names and defaults were declared in three places | ARCHITECT-8 | Fixed `902548c`, `8e1d8ae` |
| DR-31 | Info | 401/403 denials fell through to third-party providers silently | SECURITY-8 | Logged once; `WEB_SEARCH_THIRD_PARTY=0` opt-out `0ecc4dc` |
| DR-32 | Info | Bundling the PR #8 rewrite hampers bisecting | CRITIC-8 | Merged with a merge commit `43ea788` |
| DR-33 | Info | Hosted instructions lacked untrusted-content framing | SECURITY-7 | Fixed `902548c` |
| DR-34 | Info | `user_location` was still rejected with 400 | CRITIC-7 | Fixed `902548c` |

### Introduced by the fixes

| ID | Severity | Finding | Source findings | Status |
|---|---|---|---|---|
| R-1 | Medium | Cited and opened links used the comparison key, which drops the fragment, so hash-routed pages such as `#/api/users` and `#/api/widgets` collapsed into one wrong link | CROSS-PROVIDER-2-R | Fixed `0b464f4` |
| R-2 | Low | Hosted search's own admission gate doubled the opt-in concurrency and spacing limits | ARCHITECT-1-R, CODE-REVIEWER-1-R | Fixed `0b464f4` |
| R-3 | Low | A genuine empty result became `unavailable` when a later provider ran past the total deadline | ARCHITECT-2-R | Fixed `0b464f4` |
| R-4 | Low | `main`'s proxy answers only the exact path `/health`, so legacy detection never fired | CRITIC-1-R | Fixed `0b464f4` |
| R-5 | Low | The hosted-search pause was effectively untested, because the separate gate's cooldown masked it | TEST-ENGINEER-1-R | Tests added `0b464f4` |
| R-6 | Low | The R-1 fix re-encoded a citation's query only when it carried `utm_source`, so a source such as `?q=node/lts` and its citation no longer matched: a duplicate link, and a lost title | CODE-REVIEWER-2-R | Fixed `bcbd634` |

### Conflicts between reviewers

- **Which `tool_choice` hosted search sends for Opus 5.5 (CRITIC-2 vs TEST-ENGINEER-6).**
  - Both were right for their inputs. The captured Claude Code 2.1.303 requests settle it: every 5.5 ID, dashed or dotted, sends `auto`.
  - Hosted search now always sends `required`.
- **Fallback after a 401/403 (ARCHITECT-1 vs SECURITY-8).**
  - The architect wants guaranteed fast fallback. The security reviewer does not want policy refusals to reach third-party providers silently.
  - Hosted search now pauses for five minutes after a 401, 403 or 404, and a GitHub search refusal is logged once as a possible policy refusal.
  - Exa/Parallel and DuckDuckGo remain the fallback, as the user decided when approving the plan.
- **Whether every provider receives the token (ARCHITECT-7 vs security kudos).** Both were right: every provider function received the token, but only GitHub's used it. Now only GitHub's receives it.

## DR-1 and R-2: hosted search could stall all Claude traffic

**Observed:** Hosted `/responses` calls used the same upstream client as every Claude request: one admission gate with its cooldown, and the general retry loop. Three reviewers reproduced the failure offline:
- A 429 with `Retry-After: 60` from the search model put the shared gate into cooldown.
- The provider fallback was then rejected locally ("Copilot is cooling down"), and the WebSearch ended in an error.
- An unrelated plain request got HTTP 429 without reaching Copilot.
- Shorter `Retry-After` values caused up to four hosted attempts and delayed the fallback by 12–32 seconds.

**Fix:**
- Hosted search has its own client. It makes one attempt, uses the `WEB_SEARCH_TIMEOUT_MS` deadline, and never applies its `Retry-After` to the gate.
- The first version gave that client its own gate, which doubled the user's opt-in concurrency and spacing limits (R-2). The client now shares the gate, so those limits cover all Copilot requests, while a `Retry-After` from the search model pauses only hosted search.
- After a 429 or 503 with `Retry-After`, the proxy skips hosted search for that period; after a 429 without the header, for one minute.
- After a 401, 403 or 404, it skips hosted search for five minutes and goes straight to provider search.

**Tests cover:**
- a 429 with `Retry-After: 60`, then an ordinary request, then a second search;
- a 500, which is attempted once even with `COPILOT_MAX_RETRIES=3`;
- six pause cases (R-5);
- spacing that the shared gate enforces between a Claude request and a hosted search.

## DR-2 and DR-4: hosted search answers only what it can answer faithfully

**Observed:**
- Eligibility rejected known-bad shapes, so any other field passed and was dropped. `stop_sequences`, `temperature`, `output_config.format` and an assistant prefill all disappeared. A JSON-schema request came back as prose, labeled as Claude.
- Claude Code 2.1.303 sends `tool_choice: auto` for every 5.5 model, including the default Opus 5.5. A reply with no search, a failed search plus an apology, or a refusal was returned as a successful search. Claude Code shows `stop_reason: refusal` as a safeguards error.

**Evidence:** The installed Claude Code 2.1.303 sent nested WebSearch requests for `claude-sonnet-5`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-opus-5.5`, `opus` and `sonnet`. They use only these fields: `model`, `messages`, `system`, `tools`, `tool_choice`, `metadata`, `max_tokens`, `thinking: {type: "disabled"}` (forced shape only), `output_config: {effort}`, and `stream`.

**Fix:**
- Eligibility is an allow-list of exactly those fields. It also requires:
  - an empty `stop_sequences`;
  - disabled or adaptive thinking;
  - `output_config` with only `effort`;
  - a final user turn.
- Hosted search always sends `tool_choice: "required"`.
- A reply without a completed search, or with a refusal, falls back to provider search.

## DR-6, DR-27 and R-1: links and domains

- Pages the model opened or cited that no search listed are appended to the last completed search's results.
- Those links keep their fragment and drop only the `utm_source` tracking parameter. It is removed from the query text, so the other parameters keep their exact encoding and a citation still matches its source (R-6). Hash routes count as distinct pages; anchors and text fragments match the page they belong to.
- With `allowed_domains`, any source, page read or citation outside the list sends the request to provider search, which enforces the domains itself.
- Unit tests cover:
  - subdomains (`www.nodejs.org` is kept);
  - lookalikes (`evilnodejs.org` falls back);
  - off-list page reads and citations;
  - hash routes, anchors and text fragments.

## DR-13: Chat transport

Hosted search does not call the requested model, so it now runs before any output and before the transport check. The 501 applies only when provider search would be needed on a non-native transport, and it is returned before streaming starts. As a result, the `started` handshake between hosted search and `runWebSearch` is gone (part of DR-26).

## DR-3, DR-5, DR-15, DR-20 and R-3: provider search robustness

- A full search queue now becomes a `too_many_requests` search result, and an unexpected provider failure an `unavailable` result; neither fails the response.
- A round's searches settle before their results are emitted, whole and in call order.
- A fatal failure cancels the round's other searches, so nothing is written after the error event.
- Domain lists are applied inside the provider chain, so a provider whose results are all excluded no longer ends the fallback.
- A new `WEB_SEARCH_TOTAL_TIMEOUT_MS` (60 seconds) bounds one search across all providers. A provider's genuine empty result still stands when a later provider runs past it (R-3).
- The search queue keeps the Copilot queue settings. The architect accepted this, because overload now becomes a tool error.

## DR-9, DR-24, DR-29 and R-4: launcher

- `/health?nonce=<hex>` returns `key_proof`, an HMAC-SHA256 of the nonce under the local key.
- The launcher checks the proof in one Node process that receives the key through its environment. It no longer runs curl and never sends the key, so a process that takes the port cannot collect the key or Claude Code's prompts.
- A proxy from `main` answers only the exact path `/health`. The launcher therefore checks plain `/health` after a 404 (R-4), and on finding the old proxy it prints exact upgrade commands.
- The README example passes the key to curl on stdin.
- The Docker smoke test checks the container's proof.

## Follow-up (PR #12)

PR #12 resolves the deferred findings, one commit each, and each commit passes the suite on its own.

**Confirmation:** the security reviewer, the architect and the correctness reviewer re-checked their own findings at `91e6a8d`. All are resolved, none of them found a new defect, and all three approve. The correctness reviewer compared 20 request scenarios before and after the handler split: status, headers, bodies and logs were identical.

- **DR-28 (`ae8c1ea`).**
  - On Windows, the temporary credential file is now created inside a staging folder whose ACL already grants only the current user, so the file never has the folder's inherited access.
  - The file is still protected on its own, so it stays private after it is renamed or linked into place.
  - A new test grants Everyone read access to the fixture folder and checks each temporary file's ACL at creation. It fails on the old code.
  - POSIX is unchanged: mode 0600 at creation has no such window.
- **DR-26 (`ff9f96a`, `05858f7`).** `createHostedSearch` in `hosted-search.mjs` owns hosted search and its pause. `handle()` keeps the request lifecycle, routing, error handling and cleanup, and delegates to route helpers that share a per-request context.
- **DR-30 (`8e1d8ae`).** `createSearchProvider` completes partial configuration with `readConfig`, so the defaults live in one place and an invalid setting fails as it does in the proxy.
- **DR-31 (`0ecc4dc`).**
  - `WEB_SEARCH_THIRD_PARTY=0` limits provider search to GitHub's search, so a policy refusal never sends the query to a third-party provider.
  - The default keeps the fallback the approved plan requires; its refusal warning now names the setting.
  - `WEBSEARCH_PROVIDER=exa` or `parallel` contradicts the setting and is rejected at startup.
- **DR-23 residual (`20a3fce`).** The searches of a rejected hosted answer are now counted in `web_search_requests`, like its tokens. They do not count against the fallback's `max_uses`, because the client never sees them.

**Accepted residuals:**
- **SECURITY-2.** The health proof is not bound to the proxy's address, so a process holding the port could relay the nonce to a genuine proxy on another address or port. The default setup runs no such second proxy, and binding the proof to the port would break Docker's port mapping.
- **Installed-client tests in CI.** CI does not install Claude Code, so the three tests that run the installed client run only locally. An optional CI job with a pinned Claude Code version would cover them.

## Verification

**Test suite:**
- **Node 26.13 with the installed Claude Code 2.1.303:** 290 tests, 289 pass, 1 skipped (POSIX-only permission test on Windows).
- **Node 22.23 and 24.22:** 286 pass, 4 skipped (the three installed-client fixtures and the POSIX test).
- Each fix commit passes the suite on its own.

**CI:** passes on Ubuntu and Windows with Node 22, 24 and 26, and so does the Docker smoke test, for both the push and the pull request on `0b464f4` and on `bcbd634`.

**Tests that detect the original bugs:**
- 32 new or changed tests fail on `3bfea44`. Four fail on `d9058c7`, and the new link assertion fails on `0b464f4`.
- Targeted mutations of guarded code are detected:
  - nine coverage pins;
  - the hosted-search pause: 6 of 7 pause tests fail without it;
  - the test engineer's five deliberate breaks of the pause and gate code.

**Live against Copilot, at the final head, six scenarios:**
- **Hosted search, streaming:** 4.2 s, 1 search, 20 sources.
- **Hosted search, JSON with `allowed_domains`:** 14 sources, all on nodejs.org.
- **`blocked_domains`:** sent to provider search; GitHub's results exclude the blocked domain.
- **Missing search model:** provider search, with a single `message_start`.
- **Chat transport with `user_location` and `auto` choice:** hosted search still searched (5.7 s).
- **Provider search with `allowed_domains`:** results only from nodejs.org.

**Real Claude Code 2.1.303, end to end on the default Opus 5.5:** a plain prompt returns OK, and WebSearch is answered by one hosted GPT-6 Luna search that cites nodejs.org/en/download.

**Follow-up (PR #12):**
- **Test suite:** on Node 26.13 with Claude Code 2.1.303, 295 tests, 294 pass, 1 skipped; on Node 22.23 and 24.22, 291 pass, 4 skipped. Each commit passes the suite on its own.
- **Tests that detect the fixes:** the new tests for DR-28, DR-30, DR-31 and the DR-23 residual fail without their fixes.
- **Live against Copilot:** the six scenarios above pass again. So do provider search with `WEB_SEARCH_THIRD_PARTY=0`, which returned GitHub's results without trying a third-party provider, and plain JSON, streaming and token-count requests through the split handler.
- **Real Claude Code 2.1.303, end to end:** a plain prompt returns OK, and WebSearch cites nodejs.org/en/download.

## Strengths noted by reviewers

- `hosted-search.mjs` is a pure mapping module, unit-tested against captured `/responses` payloads, with no import cycles. The building blocks in `runtime.mjs` (ProxyError, the admission gate, single-flight, `openResponse`) are reused across modules.
- Cancellation is correct. A client abort during the hosted call cancels the upstream request without falling back. A shared search survives one subscriber aborting, is cancelled after the last one leaves, and releases its admission permit.
- Domain handling is careful. Hostname-boundary matching is used throughout, `blocked_domains` go to provider search rather than being guessed, and `javascript:` URLs and duplicate tracked URLs are dropped.
- The GitHub token goes only to `api.githubcopilot.com`, as a bearer header. Every fetch refuses redirects, third-party providers get no credentials, and logs carry only locally written messages; all of this is tested.
- The gateway is hardened:
  - a 256-bit key, compared in constant time before the body is read;
  - a loopback default, with Compose publishing only on 127.0.0.1;
  - a CI smoke test for binding, read-only mounts and blocked egress;
  - credential publication that is atomic and never overwrites an existing file;
  - `store: false` on `/responses`.
- Failures are reported honestly. The native and Chat streams reject incomplete completions instead of reporting a successful `end_turn`, and unknown optional `web_search` fields are ignored rather than breaking WebSearch.
- The tests and docs are strong:
  - The GitHub MCP provider tests caught all 5 deliberate breaks.
  - Ten concurrent runs of the suite produced no flaky failures.
  - The Node 26 test fix is minimal and well diagnosed.
  - The README says plainly that GPT-6 Luna writes the search summary, and covers privacy and billing.
