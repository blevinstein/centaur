# Email as a platform

Status: **proposal**, not built on `main`. This document is the plan behind the "Needs triage" item in
[TODO.md](../../TODO.md) ("Consider adding email support, think about SMTP complexity"). It builds on
[platforms-and-destinations.md](../platforms-and-destinations.md), [plan.md](../plan.md) and
[poster.md](../poster.md).

Claims about AWS service behavior and about the Chat SDK adapter catalog come from general knowledge
and an npm search, not from this repo; they are marked **(unverified)** and should be checked before
building.

## Summary

Email fits the existing model as a third connection type, but it is the first platform that is not a
chat room with a bot token, so more of the model bends than for Slack. The expensive part is not SMTP.
Sending is one API call through SES. The expensive parts are the inbound trust model (anyone on the
internet can send to the address, and the `From` header is forgeable), threading from message headers,
and the absence of a Chat SDK adapter, which means writing one.

Recommendation: **SES for both directions**, inbound by SES receiving rules that write the raw
message to S3 and notify a Lambda, outbound by the SES API (not SMTP). Build it as a custom Chat SDK
adapter, DM-only at first, with an allowlist of senders plus a DMARC-pass requirement. Do this in
four slices; the first is useful on its own (the bot answers allowlisted senders by email).

## What the codebase assumes today

- **Platforms are a closed enum.** `PLATFORMS = ["telegram", "slack"]` in `src/config/schema.ts`
  drives the config schema, the route regex (`/^\/(telegram|slack)\/...$/` in `src/lambda/receiver.ts`),
  `ADAPTER_FACTORIES` in `src/lambda/chat.ts`, `ADMIN_CHANNELS`, and `THREAD_PLATFORMS` in
  `src/lambda/thread-starter.ts`. Each is a `Record<Platform, ...>`, so adding a member is a compile
  error until every table has an entry. That is the intended extension point.
- **A connection is a Chat SDK adapter plus SSM secrets.** `createChat` builds one `Chat` with one
  adapter per connection, from `bots/<bot>/platforms/<platform>/token` and `webhook-secret` or
  `signing-secret`. The adapter verifies the webhook. Everything after that (ownership, access,
  dispatch, history, reactions) is platform-neutral Chat SDK code.
- **Thread IDs are prefixed by the adapter** (`telegram:<chat>:<topic>`, `slack:<channel>:<ts>`), so
  `threadKey` and every store keyed by it need no change for a new prefix.
- **Access is by chat and user ID** (`approved-chats`, `approved-users`, `blocked`), with a per-platform
  admin (`admin/<platform>`) who is reached by a direct message and answers with a reaction
  (`ADMIN_CHANNELS`).
- **The receiver is a Lambda function URL** with `AuthType: NONE` and no API Gateway
  (`infra/centaur.yml`). Attachments are copied to the session bucket under `attachments/` by
  `src/lambda/attachments.ts` (20 MB cap per attachment).
- **Outbound is the poster** (`src/lambda/poster.ts`): `post`, `read`, `unreact`, `start-thread`,
  called by the runner with a GitHub OIDC token. `start-thread` opens a topic (Telegram) or top-level
  post (Slack) per destination.

## Where email does not look like a chat platform

| Concern | Telegram / Slack | Email |
|---|---|---|
| Delivery to the receiver | Platform pushes a signed webhook | The receiver must be fed: SES hands over a notification, or a poller pulls |
| Request authenticity | Signature or secret token verified by the adapter | No signature; the `From` header is forgeable, authenticity comes from SPF, DKIM and DMARC results |
| Identity | Stable numeric or `U...` ID | An address string, which the sender controls and which can differ between `From`, `Reply-To` and `Return-Path` |
| Thread | Native thread or topic ID | Reconstructed from `Message-ID`, `In-Reply-To`, `References`; a client may break the chain |
| Reactions | Native (the 👀 ack, approval reactions) | None |
| Message edit and delete | Native | None; every message is final |
| Group chat | Yes, with respond-to-mention rules | A thread with several recipients; no mention concept |
| Rich text | Markdown or platform formatting | `text/plain` and `text/html` alternatives, quoted history, signatures |
| Bots talking to bots | Bots rarely see each other | Auto-replies, mailing lists and bounces are routine and must be filtered |

The two that cost the most are authenticity and the lack of reactions. The 👀 ack and the admin approval
flow (`APPROVE_EMOJI` reactions) both rely on reactions, so email needs another answer for each (below).

## Inbound options

### A. SES receiving, to S3 and a Lambda (recommended)

An SES receipt rule set for a verified domain (or a subdomain, for example `bot.<domain>`) stores the raw
MIME message in an S3 bucket, then invokes the receiver (action order: S3, then Lambda or SNS). The
raw message in S3 keeps the full headers and attachments without the 150 KB SNS and 256 KB async-Lambda
payload limits, and gives a replayable record.

- Pro: stays inside the one-AWS-account model; no third-party account or secret; SES attaches the
  verdicts for SPF, DKIM, DMARC, spam and virus (`receipt.spfVerdict`, `dkimVerdict`, `dmarcVerdict`,
  `spamVerdict`, `virusVerdict`) to the event, which is exactly the trust input the access check needs.
  Cost is per message (see [Cost](#cost)).
- Con: SES inbound is available only in a subset of regions (us-east-1, us-west-2, eu-west-1 and a few
  others **(unverified)**); the stack's region may not be one, and the MX record must point at the
  inbound endpoint of that region. Domain verification and MX need DNS access to a domain the maintainer
  owns, which self-hosters may not have, and a domain outside Route 53 means manual records.
- Shape of the integration: the function URL cannot receive an SES action, so either the receiver
  Lambda gains a second entry point (the handler distinguishes an SES event from a Function URL request;
  the existing `src/lambda/handler.ts` would branch on event shape), or a small second Lambda reads the
  S3 object, verifies, and calls into the same receiver code. A separate Lambda keeps the HTTP path
  unchanged and gets its own IAM role scoped to the inbound bucket.

### B. Provider inbound webhook (Postmark, Mailgun, SendGrid, Resend, and similar)

The provider receives mail and POSTs parsed JSON to a URL. This fits the existing function-URL receiver
and route (`/email/<bot>`) with almost no new infrastructure, and the provider does the MIME parsing and
often the SPF/DKIM verdicts.

- Pro: no region limit, no MX management beyond pointing at the provider; reuses the existing webhook
  verification shape (a shared secret or signature in SSM, like `webhook-secret`).
- Con: a third-party dependency and account; message content passes through the provider; each provider
  has its own payload, so the adapter is provider-specific unless one is picked; attachment size limits
  and retention vary.
- Reasonable if SES inbound turns out to be unavailable in the stack's region. Pick one provider and do
  not abstract over several.

### C. IMAP polling

A scheduled Lambda (EventBridge) logs in to a mailbox (Gmail, Fastmail) and fetches unseen messages.

- Pro: works with an existing personal mailbox; no domain or MX; the consumer can read the same mailbox.
- Con: latency is the poll interval; credentials (an app password or OAuth refresh token, which expires
  or needs re-consent) live in SSM; IMAP libraries are stateful and awkward in Lambda; the shared mailbox
  mixes the bot's mail with the human's, so "which messages are for the bot" needs rules; and the
  provider can disable the login. Not the recommended path, but the cheapest way to try the idea against
  a real inbox before buying a domain. The two "recruiter email" and "business opportunities" prompts
  in TODO.md are this shape: a human's inbox the agent triages, not a bot address people write to.

Note that those two use cases differ from the address-the-bot case. Triage of an existing inbox is a
read-and-summarize prompt (a scheduled prompt that reads mail through an MCP server such as a Gmail
connector), not a platform: no inbound routing, no replies sent as the bot. Do not build the platform to
serve them; see [Open questions](#open-questions).

## Outbound options

### SES API (`SendEmail` / `SendRawEmail`) (recommended)

An IAM-authorized call from the poster Lambda, with no SMTP session, no credentials to store (the
Lambda role signs the request), and the AWS SDK already in the dependency tree. `SendRawEmail` (or the
v2 `SendEmail` with `Content.Raw`) is needed to set `In-Reply-To` and `References`, which the simple
`SendEmail` body does not expose **(unverified for v2 header support; a raw MIME message always works)**.
Build the MIME with a library (nodemailer's `MailComposer`, or `mailparser` for inbound), never by hand;
this matches the preference against hand-rolling encodings.

### SMTP

SES also exposes an SMTP endpoint, as does every provider. It means SMTP credentials in SSM (derived
from IAM keys for SES), a TCP session per send from a Lambda, and the same MIME composition work. Its
only advantage is portability off SES. The "SMTP complexity" in the TODO item is therefore avoidable:
with SES, SMTP is never spoken. Choose SMTP only when sending through a provider that has no HTTP API.

### Sending constraints

- A new SES account is in the **sandbox**: it can send only to verified addresses, with low daily and
  per-second limits, until a production-access request is approved **(unverified: current limits and
  review turnaround)**. The allowlist-only design below works inside the sandbox for the maintainer's
  own addresses, which is enough for slice 1.
- The sending domain needs verified DKIM (Easy DKIM CNAMEs), an SPF include, and a DMARC record, or
  replies land in spam.
- A configuration set with SNS or EventBridge event destinations reports bounces and complaints;
  these must be handled (see [Loops, bounces and abuse](#loops-bounces-and-abuse)).

## Threading

Email has no thread ID, so the adapter derives one. Use the RFC 5322 headers:

1. If the message has `In-Reply-To` or `References`, look up each referenced `Message-ID` in a state
   key `email-msg:<message-id> -> threadId` (written for every message the bot receives or sends). The
   first hit wins. This keeps a reply attached to its thread even when a client drops `References`.
2. Otherwise start a new thread whose ID is `email:<hash of the root Message-ID>` (a hash, not the
   raw ID: `Message-ID` values include sender hostnames, and the repo's rule is that public things use
   hashes of identifiers; thread IDs themselves are already treated as sensitive).
3. Outbound replies set `In-Reply-To` to the message being answered and `References` to the thread's
   chain, and keep the `Subject` with a single `Re: `. Store the SES-assigned `Message-ID` of every sent
   message under the same lookup key, because SES may rewrite the header **(unverified)**, so read it
   back from the send response rather than trusting the one set in the request.
4. Subject-based fallback matching is deliberately not used: it merges unrelated mail (`Re: hi`).

The thread's identity is "this chain of Message-IDs", so a human forwarding the mail to someone else
starts a new thread, which is the correct behavior. This maps onto the existing `thread-meta`,
history window, `threadKey` and dispatch payload unchanged: the dispatch payload carries
`thread_id`, whose prefix (`email`) selects the platform.

A chat message's *channel* has no email analog. Treat each external correspondent as a **DM**: the
"chat" is the sender address (hashed in IDs), the "thread" is the chain. `channelId` for a chat-ID
slice is then `email:<hash of sender address>`. Group threads (several recipients) are out of scope for
the first cut: the bot replies only to the sender, not reply-all.

## Authentication and spoofing

This is the part most likely to go wrong. Email's `From` is a claim, not a proof.

- **Require an authenticated sender, not just an allowed one.** Accept a message only when SES reports
  DMARC `PASS` for the `From` domain (DMARC pass implies SPF or DKIM passed *and aligned* with the
  `From` domain; SPF or DKIM alone does not prove the visible `From`). A message whose verdicts are
  `FAIL`, `GRAY`, or `PROCESSING_FAILED` is dropped and logged by hash only. If the sender's domain
  publishes no DMARC policy, SES's DMARC verdict is not a pass; a sender on such a domain cannot be
  trusted and is ignored. **(unverified: exact verdict semantics when no DMARC record exists; check
  the SES receiving event reference.)**
- **Allowlisted senders.** Access today is `approved-users` keyed by user ID. For email the user ID is
  the lowercased address. Reuse the same SSM records (`bots/<bot>/platforms/email/approved-users/<id>`)
  with the address, or its hash if parameter names must not contain addresses. The existing resolver in
  `src/lambda/access.ts` then works unchanged. Unknown senders are ignored (never auto-replied: a reply
  to a stranger is backscatter and confirms the address exists). No open "access request to admin" flow
  in slice 1.
- **Admin claim equivalent.** `admin claim` today proves control of a chat account by sending a code
  from the account to the bot. For email the same proof works: `centaur admin claim <bot> --platform
  email` prints a code, the admin emails `claim <code>` to the bot address from the address they want
  as admin, and the claim handler (`src/lambda/admin-claims.ts`, which already takes a user ID and an
  `isDM`) binds `admin/email` to that address. This is only as strong as the DMARC gate above, so the
  claim must require DMARC pass and the same failure cap (`MAX_CLAIM_FAILURES`). The admin address's
  mailbox security then becomes the trust root; that is the same exposure as a Telegram account.
- **Admin notifications and approvals.** `ADMIN_CHANNELS` needs an entry: `notify` sends an email to the
  admin, and `verdictForReaction` does not apply. Replace reactions with a reply keyword (`approve` /
  `deny` as the first line of a reply that threads to the notification), parsed from the inbound
  message. This is the second place where the platform model needs a new capability (see
  [Model changes](#model-changes)). In slice 1 the admin flow can simply be unavailable for email
  (`commands: false`, no access requests), with approvals done through the CLI or another connection.
- **Never act on content in the body as authority.** Email bodies are untrusted input to the agent,
  as chat messages already are; the existing prompt-injection stance applies, and quoted history
  (`>` lines, `On <date>, <name> wrote:`) must be stripped before the message becomes the turn's text
  so an earlier forwarded instruction is not re-presented as new. Use a library for reply parsing
  (for example `email-reply-parser`) **(unverified: pick one after checking maintenance)**.
- **Webhook route.** With option B the provider's signature or secret is the equivalent of the Telegram
  secret token and goes in SSM as `webhook-secret`. With option A there is no public route; the Lambda
  is invoked by SES (a resource-based permission with `Principal: ses.amazonaws.com` and a
  `SourceAccount` condition), which is a smaller attack surface than another unauthenticated URL.

## Attachments

`src/lambda/attachments.ts` already copies chat attachments into the session bucket under
`attachments/<bot>/<thread>/` with a 20 MB cap, and the runner reads them from there. For email:

- Parse the raw MIME from S3 (`mailparser`) and feed each attachment through the same store; the
  adapter's `Message.attachments` carries them as the Chat SDK expects.
- SES receiving caps a message at 40 MB **(unverified)**; keep the existing 20 MB per attachment limit and
  drop oversize ones with a note in the reply.
- Inline images (`cid:`) and tracking pixels are skipped; only attachments with a filename are kept.
- Filenames are attacker-controlled: the store already sanitizes path segments (`safeSegment`); keep
  that and do not trust the MIME `Content-Type` (the existing image-extension allowlist applies).
- Executable and archive types are stored but never opened by the Lambda. The SES virus verdict
  (`virusVerdict`) is a gate: anything but `PASS` is dropped.
- Outbound attachments are out of scope until the agent has a use case; the runner's replies are text.

## HTML versus text

- **Inbound.** Prefer the `text/plain` part. When only HTML exists, convert with a library
  (`html-to-text` or `mailparser`'s `text` fallback), not by regex. Strip quoted history and
  signatures. Never pass raw HTML to the agent: it is large, carries tracking links, and is a vector
  for hidden-text injection (white-on-white text).
- **Outbound.** Send a `multipart/alternative` message: the agent's Markdown as plain text, and an HTML
  rendering of it (with a Markdown library, with HTML escaped). Plain text only is acceptable for slice
  1 and is the most reliable in clients. The adapter's `renderPostable` (the Chat SDK's formatting
  hook) is where the conversion lives.
- No tracking pixels, no remote images, and no reply-to different from the bot address.

## Loops, bounces and abuse

A bot that answers email is exposed to mail loops that chat platforms rarely produce.

- **Do not reply to automated mail.** Drop inbound messages with `Auto-Submitted` other than `no`,
  `Precedence: bulk|list|junk`, `List-Id` or `List-Unsubscribe`, an empty or `<>` `Return-Path` (a
  bounce), or a `From` of `MAILER-DAEMON` or `postmaster`. Set `Auto-Submitted: auto-replied` on every
  reply the bot sends, so other bots also stay quiet.
- **Never reply to the bot's own address.** Drop a message whose `From` equals a bot address.
- **Rate limit per sender and per thread** in the state table (a counter with a TTL, the same pattern as
  the access-request 10-per-hour limit): for example, at most N bot replies per sender per hour, then
  silence and a log line. This bounds the damage from a ping-pong with an auto-responder that
  slips past the header checks.
- **Bounces and complaints.** Configure the SES configuration set to publish `Bounce` and `Complaint`
  events; a hard bounce or complaint writes `blocked/user/<address>` through the existing blocked
  store, so the sender is never mailed again. This protects the SES reputation: SES suspends accounts
  with high bounce (above roughly 5%) or complaint rates (above roughly 0.1%) **(unverified: current
  thresholds)**.
- **Backscatter.** Reply only to allowlisted, DMARC-pass senders and to the verified `From`; never to
  `Reply-To`, `Return-Path` or addresses in the body, which would let a spoofer redirect the answer.
- **Cost abuse.** Unauthenticated mail is dropped before the agent runs, and every dispatch goes
  through the existing `repository_dispatch` path, whose spending limits apply per turn. The new
  exposure is the receiver being invoked per inbound message, bounded by the SES rule set's
  recipient filter (only the bot addresses).

## Cost

All figures are order-of-magnitude and **unverified**; check current AWS pricing.

- SES: about $0.10 per 1,000 outbound messages and about $0.10 per 1,000 inbound messages (plus a small
  per-GB charge for attachments and for inbound chunks of 256 KB beyond the first). A personal bot is
  cents per month.
- S3 for raw inbound mail: negligible; add a lifecycle rule (for example 30 days) so mail is not kept
  forever.
- Lambda and DynamoDB: the existing receiver cost, at the volume of one person's mail.
- A domain: the real recurring cost (about $10 to $15 per year), plus a hosted zone (about $0.50 per
  month) if Route 53 hosts it.
- A third-party inbound provider (option B) has a free tier that likely covers a personal bot, with
  per-message pricing after.

## Infrastructure and IAM

Additions to `infra/centaur.yml`, behind a condition so existing stacks are unaffected (a parameter such
as `EnableEmail`, default off):

- `AWS::SES::EmailIdentity` for the domain, with Easy DKIM; the DNS records are outputs, since the stack
  cannot assume it controls DNS.
- `AWS::SES::ConfigurationSet` plus an event destination (SNS topic or EventBridge) for bounce and
  complaint events, and a subscription to the handler.
- `AWS::SES::ReceiptRuleSet` and `AWS::SES::ReceiptRule` (S3 action, then Lambda action), with a
  recipient list limited to the bot addresses. Only one receipt rule set can be active per region, and
  activating it is an account-wide, non-CloudFormation-managed setting (`SetActiveReceiptRuleSet`)
  **(unverified)**, so the stack may need a documented manual step or a custom resource. This is the
  first piece of infrastructure in the project that touches an account-wide singleton and is the main
  risk of this design.
- An inbound S3 bucket (or a prefix in `SessionBucket`; a separate bucket is easier to lock down) with
  a bucket policy allowing `s3:PutObject` from `ses.amazonaws.com` conditioned on `aws:SourceAccount`,
  encryption, public access blocked, and a lifecycle expiry.
- A `AWS::Lambda::Permission` allowing `ses.amazonaws.com` to invoke the handler, with `SourceAccount`.
- Role additions: `s3:GetObject` on the inbound bucket (receiver role); `ses:SendEmail` and
  `ses:SendRawEmail` on the identity ARN (poster role), ideally with a `ses:FromAddress` condition.
- The new SSM parameters under `bots/<bot>/platforms/email/` (`approved-users/*`, `blocked/*`,
  `approvers/*`) are already covered by the existing `bots/*/platforms/*/...` wildcards; confirm with
  `test/infra.test.ts` and `yarn lint:cfn`, as the destinations design required. Email needs no bot
  token; a connection with no token stores only its address (`bots/<bot>/platforms/email/address`),
  which means `Bot.token` and `loadBots` need to allow an absent token (see Model changes).

## How it fits the platform and destination model

### Model changes

1. `PLATFORMS` gains `"email"`; every `Record<Platform, ...>` table gets an entry
   (`ADAPTER_FACTORIES`, `ADMIN_CHANNELS`, `THREAD_PLATFORMS`, and anything the compiler flags).
2. The route regex gains `email` only for option B. With option A there is no HTTP route, and
   `createReceiver` needs a way to deliver a non-HTTP event to the right connection's `Chat`; the
   Chat SDK's `chat.webhooks[platform]` takes a `Request`, so the SES handler either builds a synthetic
   `Request` for the adapter's webhook entry (simple, keeps the adapter standard) or calls the adapter's
   message-processing method directly **(unverified: which hook the SDK exposes)**.
3. A connection's secrets differ: email has no `token` and no `webhook-secret` with option A.
   `loadBots` and `Bot` (`token`, `webhookSecret`) assume both; relax them per platform.
4. The Chat SDK has no catalog adapter for email as far as an npm search shows (the `@chat-adapter/*`
   packages found were slack, telegram, discord, teams, gchat, whatsapp, github, linear, x, twilio,
   notion, and state stores) **(unverified: confirm there is no email adapter, including
   community ones)**. So this proposal includes writing a small `Adapter` for email (`parseMessage`,
   `postMessage`, `fetchMessages`, `handleWebhook`, thread-ID encode and decode, `renderFormatted`).
   Fetching history (`fetchMessages`) is served from the state table, because there is no mailbox to
   query under option A.
5. Capabilities the platform model assumes and email lacks: reactions (the 👀 ack and approvals) and
   typing indicators. The 👀 ack becomes a no-op (the adapter's `addReaction` returns without error), and
   `finish` already tolerates a failed or absent reaction ("A failed reaction is logged and does not
   block the dispatch"). Approvals use reply keywords as described above, or are unavailable in
   slice 1.

### Destinations

A destination names a chat and an optional thread. Email's analogs are:

- chat = a recipient address (a DM to one person); `chats/email/<name>` stores the address (or its
  hash plus a lookup) as the bare chat ID. The chat must be approved, which for email means the address
  is in `approved-users` and has not bounced or complained.
- thread = a Message-ID chain. A `thread: persistent` prompt works naturally: the first run sends a
  message and binds its `email:<hash>` thread ID; later runs reply into the chain
  (`In-Reply-To` the last message), which mail clients render as one conversation. This gives a weekly
  digest that stays one thread in the recipient's inbox, the same feature as a Telegram topic.
- `thread: new` sends a fresh message with a new subject each run.
- Subject: the prompt's `title` (already a `start-thread` input) is the subject of the opening message.
- Create-on-first-use has no email meaning (the bot cannot pick a recipient), so an email destination
  must be bound with `centaur destination set` and the existing "none or several approved chats" errors
  apply.
- `start-thread`'s `THREAD_PLATFORMS` entry for email: `open` sends the first message (`posted: true`,
  like Slack); `gone` never matches (there is no deleted thread), so there is no `reopen`; the
  `chatProblem` pattern matches SES rejections (an unverified recipient in the sandbox, a suppressed
  address).

### Respond-to and ownership

`respond_to: mention` has no meaning in email: every message to the bot address is addressed to it.
Define email as always `all` for DMs, and reject `respond_to: mention` in the config for the email
connection (the config parser can enforce this per platform). Ownership (`src/lambda/ownership.ts`)
treats email as thread-scoped only if group threads are added; in DM-only slice 1 it is moot.

### Multi-bot addressing

Several bots can share a domain: the recipient address picks the connection
(`<bot>@<domain>`), which parallels the route `/<platform>/<bot>` and keeps one SES rule set. Plus
addressing (`bot+tag@`) can carry a destination or purpose later.

## Recommendation and slices

SES in and out, custom adapter, allowlisted and DMARC-gated senders, DM-only, plain-text replies.

1. **Outbound only: scheduled prompts that email an approved recipient.** Smallest, safe, and
   demonstrates the value: `email` in `PLATFORMS`, the poster `start-thread` and `post` paths through
   SES `SendRawEmail`, destinations binding to an approved address, `persistent` threads via
   `In-Reply-To`. No inbound, no MX, no adapter message parsing, so no spoofing exposure. Needs the SES
   identity and DKIM (a domain), the IAM statement, and the sandbox-verified recipient. The email
   adapter is a stub whose `handleWebhook` rejects everything.
2. **Inbound for allowlisted senders.** Receipt rule set, inbound bucket, SES-invoked handler, MIME
   parsing, the DMARC gate, allowlist, reply parsing, header threading with the `email-msg:` lookup,
   automated-mail filters, rate limits, the 👀 no-op. This is where the cost and risk sit.
3. **Bounces, complaints and attachments.** Configuration-set events writing to `blocked/...`; attachments
   through the existing store with the virus gate.
4. **Admin over email.** Admin claim and the approve-by-reply flow, access requests from unknown senders
   (probably still not enabled: strangers should be ignored). Optionally HTML replies. Reconsider
   group threads and reply-all only on demand.

Slices 1 and 2 are each a Lambda change and a CloudFormation change, so per `AGENTS.md` the rollout
order is Lambda and infrastructure first, then the runner slices (none are needed unless `prepare`
or `finish` gain email-specific behavior).

## Alternatives not recommended

- **Gmail API or Microsoft Graph as the transport** (OAuth to a person's mailbox): good for "triage my
  inbox", wrong for "the bot has an address", and carries refresh-token upkeep. Better served by an
  MCP connector the agent uses in a scheduled prompt, which needs no platform.
- **Forwarding to a Telegram or Slack bot.** A mailbox rule that forwards to a chat is a free partial
  substitute for the inbound triage use case and needs no code.
- **Running a mail server (Postfix and so on).** Never: deliverability, abuse and patching are the
  complexity the TODO item fears.

## Open questions

1. What is the use case: a bot with its own address that people write to, outbound-only digests, or
   triage of the maintainer's existing inbox? The first needs slices 1 to 3, the second only slice 1,
   and the third needs no platform at all (an MCP mail connector in a scheduled prompt).
2. Is there a domain to host the bot address and who controls its DNS? SES identity, DKIM and MX all
   depend on it.
3. Which region does the stack run in, and does SES inbound exist there? If not, option B (a provider
   webhook) or a cross-region SES rule set is needed.
4. Is a stack-level singleton (the active SES receipt rule set) acceptable in CloudFormation, or is a
   manual step documented in `deploy.md` preferred?
5. Is the DMARC-pass requirement too strict for the intended senders (some personal domains publish no
   DMARC policy), and if so, what is the fallback: a per-sender secret token in the address
   (`bot+<token>@`), or refuse?
6. Should the email adapter live in this repo or be published as a Chat SDK community adapter, if no
   adapter exists?
7. Do approvals (admin requests, MCP approvals, which today use reactions) need to work over email, or
   is it acceptable that an email-only bot approves through another connection or the CLI?
8. Should replies preserve a human-looking `From` name (the bot's display name) and which `Reply-To`,
   given spoofing concerns?
