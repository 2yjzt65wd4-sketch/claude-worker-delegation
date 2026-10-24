# claude-worker-delegation

An MCP server that turns Claude Code into an **architect** that hands bulk work to **cheap worker models** on OpenRouter.

Premium models are great at planning and review, but paying premium rates for them to read a 300 KB log or write boilerplate is wasteful. This server gives Claude Code three tools that offload that work. The big file contents go straight from disk to the worker model, so they never enter Claude's context.

```
             ┌──────────────────────────┐
  you ──────▶│  Claude Code (architect) │  plans, decides, reviews, runs commands
             └────────────┬─────────────┘
                          │ MCP (stdio)
             ┌────────────▼─────────────┐
             │  workers MCP server      │  tiers · budget cap · path sandbox · cost log
             └────────────┬─────────────┘
                          │ OpenRouter API
      ┌──────────┬────────┴──┬────────────┐
      ▼          ▼           ▼            ▼
    fast       code       reason        long
 (summaries) (diffs/tests) (2nd opinion) (1M-token files)
```

## Tools

| Tool | What it does |
|---|---|
| `delegate` | Run one task on a worker tier. Pass `files` and the server reads them from disk. `write_to` saves long output to a file and returns only a 20-line preview. |
| `delegate_batch` | Run several independent jobs in parallel (concurrency set in config). |
| `worker_stats` | Token and cost totals for today and all time, broken down by tier. |

## Features

- **Tiered models** in `models.json`: `fast`, `code`, `reason`, and `long`. Each tier has a description the architect uses to pick one.
- **Daily budget cap.** Calls are refused once the day's spend reaches `daily_budget_usd`.
- **Cost logging.** Every call is appended to `usage.jsonl` with its tokens, dollar cost, and latency.
- **Path sandbox.** Workers can only read and write files under the session's working directory, plus any extra roots set in `WORKERS_ALLOWED_ROOTS`.
- **Guard-railed worker prompt.** Workers are told to answer tersely, return unified diffs for code, and never invent file contents they weren't shown.
- **Provider settings.** OpenRouter routing sorts by price, allows fallbacks, and denies data collection.
- **Large-read hook** (`hooks/delegate-large-reads.cjs`). A Claude Code `PreToolUse` hook that blocks whole-file reads over 50 KB, whether through `Read`, `cat`, or `Get-Content`, and points Claude to `delegate` instead.

## Real usage

The first 12 calls cost **$0.09 total**, and three of them fed about 363K input tokens of logs and files to the `long` tier. All of that input would otherwise have gone through the premium model's context.

## Setup

```bash
npm install
export OPENROUTER_API_KEY=sk-or-...        # Windows: setx OPENROUTER_API_KEY "sk-or-..."
claude mcp add workers -- node /path/to/claude-worker-delegation/server.js
```

Then:
1. Add the rules in [`examples/CLAUDE.md`](examples/CLAUDE.md) to your `~/.claude/CLAUDE.md` so Claude knows what to delegate.
2. Optionally add the hook and permissions from [`examples/settings.json`](examples/settings.json) to `~/.claude/settings.json`.
3. Run `npm run smoke` to check that the tools, every tier, and the path sandbox all work.

## Config (`models.json`)

```json
"tiers": {
  "fast":   { "model": "deepseek/deepseek-v4-flash", "use": "summaries, extraction, boilerplate" },
  "code":   { "model": "qwen/qwen3-coder-next",      "use": "code, tests, diffs" },
  "reason": { "model": "deepseek/deepseek-v4-pro",   "use": "debugging, second-opinion reviews" },
  "long":   { "model": "google/gemini-3.1-flash-lite", "use": "very large files (1M context)" }
},
"daily_budget_usd": 3.0,
"concurrency": 4
```

To change models, edit this file. You don't need to change any code.

## Stack

Node.js · Model Context Protocol SDK · zod · OpenRouter API · Claude Code hooks

## License

MIT
