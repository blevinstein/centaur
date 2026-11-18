# centaur

Shared "reverse centaur" tooling: agents that handle timing and outreach for household and
personal-project repos, while humans do the physical work (shopping, gardening, ...) and review
the PRs that persist what the agents learn.

Status: **design phase**; the agent runtime is validated and infrastructure is next.

- [docs/research.md](docs/research.md) — requirements, options considered, and findings.
- [docs/plan.md](docs/plan.md) — architecture, configuration, context management, and the
  validation plan.
- [docs/cli.md](docs/cli.md) — the `centaur` CLI for bots, the admin, access approvals and chat aliases in SSM.
- [docs/onboarding.md](docs/onboarding.md) — setup flow for each chat platform and for adding a
  new repo.

## In one paragraph

Each participating repo (e.g. a garden-planning repo) gets one chat bot, on Telegram or Slack,
chosen per repo. A single AWS Lambda receives every bot's webhook via [Chat
SDK](https://github.com/vercel/chat), records the message, and dispatches a GitHub Actions
workflow in the target repo. That workflow runs `anthropics/claude-code-action@v1` against
pay-per-token API keys (Anthropic or OpenRouter), with context assembled according to an explicit
per-thread policy, then posts the reply back through the Lambda. Scheduled outreach is just a
`schedule:` trigger on the same workflow. There is no always-on server.

This repo holds no deployment-specific configuration. Each consumer repo declares its bot in
`.centaur.yml` and registers itself with the deployed Lambda; secrets and personal identifiers
live in SSM; deployment parameters live in the deployer's own infra repo.
