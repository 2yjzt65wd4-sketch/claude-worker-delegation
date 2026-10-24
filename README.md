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
- **Path sandbox.** Paths are resolved through symlinks before any check. Reads stay under the session's working directory (plus `WORKERS_ALLOWED_ROOTS`); secrets, `.env*`, `.git`, `.ssh` and key files are always refused; `write_to` is disabled unless `WORKERS_WRITE_ROOTS` is set. See [Security](#security).
- **Guard-railed worker prompt.** Workers are told to answer tersely, return unified diffs for code, and never invent file contents they weren't shown.
- **Provider settings.** OpenRouter routing sorts by price, allows fallbacks, and denies data collection.
- **Large-read hook** (`hooks/delegate-large-reads.cjs`). A Claude Code `PreToolUse` hook that blocks whole-file reads over 50 KB, whether through `Read`, `cat`, or `Get-Content`, and points Claude to `delegate` instead.

## Real usage

The first 12 calls cost **$0.09 total**, and three of them fed about 363K input tokens of logs and files to the `long` tier. All of that input would otherwise have gone through the premium model's context.

## Setup

```bash
npm ci --ignore-scripts                    # exact versions from package-lock.json
npm test                                   # offline: a fake OpenRouter on loopback, no key needed
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
  "fast":   { "model": "deepseek/deepseek-v4.1-flash-1017", "params": { "reasoning": { "enabled": false } }, "use": "summaries, extraction, boilerplate" },
  "code":   { "model": "deepseek/deepseek-v4.1-flash-1017", "params": { "reasoning": { "enabled": false } }, "use": "code, tests, diffs" },
  "reason": { "model": "deepseek/deepseek-v4.1-flash-1017", "params": { "reasoning": { "enabled": true } },  "use": "debugging, second-opinion reviews" },
  "long":   { "model": "deepseek/deepseek-v4.1-flash-1017", "params": { "reasoning": { "enabled": false } }, "use": "very large files" }
},
"default_max_tokens": 16000,
"daily_budget_usd": 3.0,
"concurrency": 4
```

To change models, edit this file, or put overrides in an untracked `models.local.json` that is merged over it key by key (for example `{"tiers": {"code": {"model": "..."}}}`). You don't need to change any code.

Also read from this file: `reserve_usd_per_job` (default 0.05, held against the daily budget while a job runs), `fallback_cost_usd` (default 0.01, charged when OpenRouter reports no cost) and `request_timeout_ms` (default 120000). Replies are streamed (server-sent events), because a reasoning model can think for many minutes and a single silent connection is dropped by proxies and NAT layers long before that (observed: a non-streamed request cut after about 9 minutes). Two clocks apply: `request_timeout_ms` bounds the whole request, and `stream_idle_timeout_ms` (default 600000) bounds the silence between two reads, keep-alive comments included, so a dead connection is detected without capping a slow, healthy one. At roughly 50 tokens per second, set `request_timeout_ms` above `default_max_tokens` divided by that rate, otherwise a slow job fails with "did not finish answering" instead of ending at its token limit. A reasoning model can also spend the whole `max_tokens` budget thinking and return nothing ("empty completion"): raise `default_max_tokens` (the model's own maximum is the real ceiling) or cap its effort for that tier (`reasoning.effort`). The usage log records `reasoning`, the part of `out` spent thinking, when OpenRouter reports it.

## Security

The server sends the files it is given to a third-party model and writes the model's raw output to disk, so it enforces its own rules instead of relying on the client:

| Variable (`;`-separated) | Effect |
|---|---|
| `WORKERS_ALLOWED_ROOTS` | Extra read-only roots besides the session's working directory. |
| `WORKERS_DENY` | Relative paths refused for read and write, on top of the built-in secret rules. |
| `WORKERS_WRITE_ROOTS` | Folders where `write_to` may create files. Unset means `write_to` is refused. |
| `WORKERS_WRITE_DENY` | Relative paths refused for write inside the write roots. |
| `WORKERS_WORKTREE_DIRS` | Folders inside the project that hold git worktrees, e.g. `.claude/worktrees`. Unset means no special case. |
| `WORKERS_USAGE_LOG` | Where the usage log goes (default `usage.jsonl` next to the server). |

- Every path is resolved with `realpath` first, so a symlink cannot reach outside the roots. A `write_to` target that is itself a symlink is refused.
- Sub-agents often work in git worktrees stored under a denied folder such as `.claude`. With `WORKERS_WORKTREE_DIRS`, a resolved path inside a subfolder that has a regular `.git` file is judged against that worktree's own root: `WORKERS_DENY`, `WORKERS_WRITE_ROOTS` and `WORKERS_WRITE_DENY` apply relative to it, so its copy of a protected file (say `docs/plan.md`) stays protected. A `.git` folder, a symlink or a plain neighbouring folder is not a worktree. The server resolves a relative path from its own working directory, not from the caller's: a client working in a worktree must send absolute paths.
- A completion that is empty, or cut by `max_tokens`, is never written; it is still logged, since it was billed. An existing file is replaced only with `overwrite: true`, and never through a link.
- The daily budget is reserved before the call, so parallel jobs cannot overshoot it. A missing cost is charged at `fallback_cost_usd`, not zero.
- The usage log holds the length and a short hash of each task, never its text, and is created with mode 0600.
- `WORKERS_TEST_BASE_URL` redirects the API for tests, and is accepted only for `127.0.0.1` or `localhost`.

The output of a worker is still untrusted text: review what `write_to` wrote before relying on it.

## Stack

Node.js · Model Context Protocol SDK · zod · OpenRouter API · Claude Code hooks

## License

MIT
