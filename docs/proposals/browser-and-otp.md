# Read-only browser automation, in-turn OTP brokering and residential egress

Status: **proposal**. Nothing here is built. It complements [mid-turn-tool.md](mid-turn-tool.md),
[poster.md](../poster.md) and [workflows.md](../workflows.md), and records the architecture and
live findings from prototyping a Playwright-backed consumer portal integration. Terms (`turn`,
`poster`, `receiver`, `marker`, `session bucket`) follow [plan.md](../plan.md).

## Problem

Several personal-project bots need read-only data from consumer web portals that offer no API or
OAuth grant (rental marketplaces, banks without Plaid support, utility and tax portals). Three
problems show up together:

1. **Ephemeral 2FA / OTP at login.** Portal sign-in routinely prompts for a short-lived SMS or email
   verification code tied to an open browser context. Ending the turn with a question as its
   `reply` ([mid-turn-tool.md](mid-turn-tool.md#questions-and-how-the-answer-comes-back)) destroys
   that browser context; the next turn starts a fresh login and triggers a second code.
2. **Read-only safety and secret hygiene.** A Playwright script holding real portal credentials
   must not mutate account state (canceling bookings, initiating transfers, changing listings,
   sending messages) and must not leak credentials, session cookies or one-time codes into logs,
   step summaries or LLM transcripts.
3. **Datacenter IP blocking.** Even when browser headers and TLS fingerprints match desktop Chrome,
   CDN bot defenses (such as Cloudflare Bot Management) frequently return `HTTP 403` on the initial
   `GET` from GitHub Actions' Azure (`AS8075`) runner IP ranges while allowing residential IPs.

## Design

### 1. Bounded in-turn verification code broker

Unlike general clarifying questions, an OTP handshake has to stay inside the running job for a
short, bounded window (default 5 minutes, 4 second poll interval), and has to work in two execution
contexts:

- **Dispatched chat turn (`centaur-message`).** Reads `{ bot, threadId }` from
  `$RUNNER_TEMP/centaur-turn/state.json` and OIDC request credentials from
  `$RUNNER_TEMP/centaur-turn/oidc-credentials.json` (`claude-code-action` strips
  `ACTIONS_ID_TOKEN_REQUEST_*` from subprocess environments). Posts the prompt into the active
  thread and polls replies there.
- **Standalone `workflow_dispatch` or scheduled run.** Mints GitHub OIDC tokens directly from
  `ACTIONS_ID_TOKEN_REQUEST_*`, opens a thread via Poster `start-thread` on a named `destination`
  slug, and polls replies in that thread.

Because GitHub OIDC JWTs are short-lived, a fresh token is minted per Poster call rather than once
at the start of a 5 minute wait.

#### Why this belongs in Centaur rather than consumer scripts

A consumer-side script can call `start-thread`, `post` and `read` directly (and this was verified
live on Slack), but three subtleties are sharper when owned by Centaur:

1. **Sender visibility across DMs and channels.** On Slack, `read` with `visibleOnly: true` enforces
   the enrolled-user filter (`visibleInThread`), which requires an approved group/channel chat and
   rejects `slack:D*` 1:1 DMs (DMs are authorized by user, not `approved-chats`). Centralizing the
   filter in a dedicated Poster operation applies enrolled-sender checks uniformly across Slack
   channels, Slack DMs and Telegram stored history without consumer branching.
2. **Platform token stripping and timestamp precision.** On Slack, replies in a thread often start
   with `<@U…> 482910` or reference `<#C…|channel>` and `<https://…>`. Stripping angle-bracket
   tokens before matching 4–8 digit (or `123-456` / `123 456`) codes prevents user ID digits from
   matching as codes, and comparing 16-digit Slack `ts` strings (`1700000000.000100`) as `BigInt`
   microseconds avoids IEEE-754 float rounding at the 6th decimal place.
3. **Duplicate-turn suppression and transcript redaction.** A consumer script cannot cleanly stop
   the receiver from also treating the human's `"482910"` reply as a normal chat message:
   - In a `start-thread` thread (`BOT_CREATED_STATE`), `ownsMessage` is `true`, so the reply
     dispatches a `centaur-message` workflow turn and adds 👀.
   - Even inside an active turn (where the per-thread concurrency group queues the new run), once
     the first turn finishes, the queued run wakes up unless the marker moved past the OTP reply,
     and later turns see the raw code in the thread transcript.

#### Proposed Poster support (`consume-code` or `redactedMessageIds`)

Add a narrow Poster operation (or pair `post-update` with `consume-verification-code`) rather than
exposing raw thread polling to the LLM:

| `operation` | Fields | Result |
|---|---|---|
| `consume-code` | `token` (OIDC JWT, required), `bot`, `threadId`, `afterMessageId`, optional `advanceMarker` (boolean) | `{ found: false }` or `{ found: true, messageId, code }` |

When `consume-code` matches a reply after `afterMessageId` from an enrolled human user:

1. Records `messageId` in a bounded `redactedMessageIds` set on `thread-meta:<threadId>` so
   `toChatMessage` / `prepare` replaces its body with `[verification code redacted]` in all future
   agent transcripts and `centaur chat tail` output.
2. Removes the bot's 👀 reaction on `messageId` (best-effort, like `unreact`).
3. When `advanceMarker` is true (default for standalone `start-thread` OTP threads where no chat
   turn owns the marker), advances the thread's `last-processed` marker through `messageId` so any
   concurrently dispatched `centaur-message` run sees zero pending messages and exits without
   invoking the LLM. Inside an active chat turn, `finish` advances the marker past both the
   triggering message and any consumed OTP messages on completion.

Crucially, the CLI / Playwright login helper calls `consume-code` directly in Node: **the LLM never
receives or emits the verification code**.

---

### 2. Reusable read-only Playwright package (`@centaur/playwright` or workflow library)

Roughly two-thirds of a safe portal scraper is domain-agnostic and reusable across personal bots:

#### Network and interaction guard (`installReadOnlyGuard`)

- **Default-deny route interceptor (`context.route("**/*", …)`):** Installed on the
  `BrowserContext` before creating any `Page`. In `read_only` mode (the default), permits only
  `GET`, `HEAD` and `OPTIONS`, plus `POST` requests to configured GraphQL paths (`/graphql`,
  `/api/graphql`) whose JSON body parses exclusively as read-only `query` / `fragment` definitions
  under a minimal GraphQL lexer (blocking `mutation`, `subscription`, unterminated strings and
  mixed batches). All other first-party and third-party `POST`/`PUT`/`PATCH`/`DELETE` requests are
  aborted with `blockedbyclient` and recorded in a scrubbed audit log.
- **Scoped `withAuthHandshake(fn)`:** Reference-counted escape hatch entered *only* while
  submitting credentials and again while submitting the OTP form — **never held open during the
  human OTP wait**, keeping `read_only` active while polling chat. A post-auth invariant asserts the
  mode returned to `read_only`.
- **`safeClick` target guard:** Inspects accessible name, `aria-label`, text, `href`, `formaction`,
  `type` and `data-testid` before clicking, refusing `type="submit"` and destructive verbs
  (`cancel`, `delete`, `remove`, `unlist`, `refund`, `pay`, `transfer`, `send`, `reply`, `save`,
  `update`, `confirm`, etc.) in `read_only` mode.
- **Secret and PII scrubber:** Redacts registered credentials, dynamically registered OTP values,
  `Cookie` / `Set-Cookie`, `Authorization` / CSRF headers, Bearer/Basic tokens, JWTs, emails and
  high-entropy tokens across URLs, diagnostics and JSON reports.

#### S3 `storageState` session store

`GitHubRole` in `infra/centaur.yml` already grants `s3:GetObject`, `s3:PutObject` and
`s3:ListBucket` on `s3://$CENTAUR_SESSION_BUCKET/sessions/*` (SSE-S3 encrypted, 30-day lifecycle
expiration). Storing Playwright `context.storageState()` at:

```
s3://$CENTAUR_SESSION_BUCKET/sessions/<bot>/playwright/<profile>.json
```

needs **zero CloudFormation or IAM changes**:

- Stages JSON through `0o700` temp directories and `0o600` files cleaned up in `finally`.
- Treats `NoSuchKey` / `404` on load as a clean cache miss (`null`) while surfacing IAM or CLI
  failures as typed errors with S3 bucket URIs redacted.
- Validates cached sessions in `read_only` mode via a caller-supplied `verifyAuthenticated(page)`
  check (for example `GET /api/me -> 200`) before touching the login page, avoiding unnecessary
  logins and OTP prompts until the portal cookie expires.

#### Browser fingerprint consistency and challenge detection

Two Playwright defaults break on modern CDN bot checks unless corrected together:

1. **OS-matched `User-Agent` and Client Hints:** Playwright's context `userAgent` option leaves
   `"HeadlessChrome"` in `Sec-CH-UA` (`navigator.userAgentData.brands`), and hardcoding a macOS
   `User-Agent` on Linux contradicts `Sec-CH-UA-Platform: "Linux"` on the initial `GET`. Applying
   `Emulation.setUserAgentOverride` over a per-page `CDPSession` kept open for the page's lifetime
   (paired with `channel: "chrome"` so TLS/HTTP2 fingerprints come from `google-chrome-stable`
   rather than `chromium-headless-shell`) aligns `User-Agent`, `Sec-CH-UA*`, `navigator.platform`
   and `navigator.userAgentData` with the host OS.
2. **Multi-frame challenge and OTP classifier:** Inspects all frames (many portals isolate login
   and 2FA inside same-origin iframes) for Cloudflare (`403` / Turnstile), DataDome,
   PerimeterX/HUMAN, Arkose FunCaptcha and visible Google reCAPTCHA Enterprise `bframe` puzzles
   (`status: "challenge_blocked"` — exit immediately without retrying, avoiding account lockout),
   and supports both single-input (`autocomplete="one-time-code"`) and 4–8 split
   `input[maxlength="1"]` OTP forms (button-submitted or auto-submitted).

---

### 3. Residential egress when cloud runner ASNs are blocked

#### Live finding

Testing against a Cloudflare-fronted consumer portal isolated header bugs from IP reputation:

| Environment | Browser | `/` and `/login` result |
|---|---|---|
| Residential IP | Headless Chromium & Chrome | `200 OK` (no challenge interstitial) |
| GitHub Actions (`ubuntu-latest`, Azure `AS8075`) | Headless Chromium (mismatched UA) | `403` (`HTTP_WAF`) on initial `GET` |
| GitHub Actions (`ubuntu-latest`, Azure `AS8075`) | `google-chrome-stable` + matched Linux `User-Agent` & `Sec-CH-UA` | `403` (`HTTP_WAF`) on initial `GET` |

When a portal blocks cloud runner ASNs at the CDN edge, browser flags cannot bypass it; egress has
to originate from a residential or non-datacenter network.

#### Egress options for Centaur consumers

| Option | Standing cost | Infra / hardware | Privacy & isolation | Fit |
|---|---|---|---|---|
| **A. Tailscale userspace SOCKS5 exit node** | `$0/mo` | 1 always-on home device (Linux host or Apple TV) advertising `--advertise-exit-node` | Ephemeral OAuth client (`auth_keys` write) tagged `tag:ci-egress` with ACL `dst: ["autogroup:internet:*"]` only — zero LAN or tailnet peer access. Userspace `--socks5-server=localhost:1055` proxies *only* Chrome (`proxy: { server: "socks5://127.0.0.1:1055" }`), keeping AWS S3/Lambda and GitHub OIDC direct | **Best default** for operators who already run an always-on home node |
| **B. Managed cloud browser with residential proxies (e.g. Browserbase `connectOverCDP`)** | Paid tier required (~`$20/mo`+; free tiers typically omit residential proxies) | Zero home hardware; skips `playwright install chrome` | Portal cookies and login `POST`s execute inside a third-party cloud browser VM | Worthwhile when shared across several bots without home hardware |
| **C. Chat file attachments (CSV / statement / receipt upload)** | `$0/mo` | None (already built: `.centaur-turn/attachments`) | Portal credentials are never stored in GitHub Secrets | **Best choice** when exports are infrequent (monthly/quarterly accounting) |

## Decisions

Recommendations in bold; each needs the maintainer's approval before building.

1. **Where the OTP broker lives.** **Add `consume-code` (with `redactedMessageIds` and optional
   marker advancement) to the Poster and expose a Node/CLI helper in Centaur's workflow runtime,
   not an LLM MCP tool.** The code is consumed directly by the login script so verification digits
   never enter the LLM context or future thread transcripts, and replies in standalone OTP threads
   do not trigger duplicate LLM turns.
2. **Relationship to `mid-turn-tool.md`.** **Keep general agent questions as end-of-turn `reply`s;
   scope in-turn blocking strictly to short-lived verification codes consumed by deterministic
   tooling.** This preserves `mid-turn-tool.md` Decision 3 for open-ended human questions while
   solving stateful 2FA handshakes.
3. **Where the Playwright harness lives.** **Wait for a second consumer bot before extracting a
   published `@centaur/playwright` workspace package; keep the reference design here meanwhile.**
   If a second repo adopts browser automation, extract `installReadOnlyGuard`, the S3
   `storageState` store, the CDP Client Hints helper and the multi-frame challenge/OTP helpers into
   Centaur so security fixes land in one place.
4. **Egress support in Centaur.** **Document the Tailscale userspace SOCKS5 pattern (`tag:ci-egress`
   -> `autogroup:internet:*`) and accept an optional `PROXY_SERVER` / CDP endpoint in the browser
   helper; add no proxy infrastructure to the Centaur AWS stack.** Residential egress cannot come
   from AWS Lambda/NAT IPs either, so Centaur's stack stays unchanged.
