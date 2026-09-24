# Why this fork exists

This fork keeps **Claude Code as the primary coding agent** while allowing Claude-Mem's
observation, compaction, and session-summary inference to run through the **OpenCode CLI**.

- Claude Code continues to run the development session and Claude-Mem continues to capture
  its hooks, store observations, build summaries, index memory, and serve that memory back to
  future sessions.
- The expensive/high-volume memory-processing calls can be delegated to a model available
  through OpenCode, including free OpenCode models.
- OpenCode is used only as a non-interactive inference transport: this fork does **not** turn
  OpenCode into the primary coding agent and does not install a Claude-Mem OpenCode host plugin.

## Why not use the earlier OpenCode-provider fork unchanged?

An earlier implementation proved that invoking `opencode run --format json` as a Claude-Mem
provider is practical, but mixed that with broader OpenCode host/plugin integration and could
run the summarizer with agent permissions inappropriate for a memory compression worker.

A summarizer receives extremely hostile input by construction (source code, shell output, tool
results, logs, web content, README/comment text, arbitrary session text), any of which can
contain prompt-injection instructions. It does not need filesystem, shell, web, MCP, subagent,
or editing access, so this fork ports only the provider concept and makes the OpenCode process
**tool-less by default**.

## Security model

The OpenCode provider is launched with defense in depth rather than relying on a prompt saying
"do not use tools".

1. **Dedicated neutral workspace** — OpenCode runs under `~/.claude-mem/opencode-summarizer/`,
   not in the repository being observed, so project-local `opencode.json`, `.opencode/`,
   AGENTS files, and repo instructions can't reach the summarizer's environment.
2. **Isolated XDG config** — the child gets a separate `XDG_CONFIG_HOME` under Claude-Mem's
   data directory, so it never loads the user's real global OpenCode config, plugins, MCP
   definitions, or instructions. A provider that only exists via custom entries in the user's
   normal OpenCode config may be unavailable here; that's an intentional secure-by-default
   tradeoff.
3. **Isolated XDG data/state/cache** — separate `XDG_DATA_HOME`, `XDG_STATE_HOME`, and
   `XDG_CACHE_HOME` too, instead of the user's real `~/.local/share`/`~/.local/state`/`~/.cache`.
   Without this, every summarizer run was recorded as a full session in the user's personal
   Kilo/OpenCode session history. The isolated data dir starts with no `auth.json`; the
   configured free-tier models (`kilo/kilo-auto/free`, `kilo/inclusionai/ling-3.0-flash-fin:free`,
   `opencode/big-pickle`) were verified to authenticate and respond against a completely
   empty, auth-less isolated data dir. A provider that requires stored credentials would not be
   reachable in this isolated mode.
4. **Inline deny-all agent** — the provider injects a temporary `claude-mem-summarizer` primary
   agent via `OPENCODE_CONFIG_CONTENT` with deny-all permissions and disabled tools, and also
   sets `OPENCODE_PERMISSION={"*":"deny"}`.
5. **No Claude Code prompt/skills inheritance** — the child disables OpenCode's Claude Code
   compatibility prompt and skill loading, so it only sees the Claude-Mem observer conversation
   supplied over stdin.
6. **Plugins/auxiliary features disabled** — `--pure`, with default plugins, auto-sharing,
   auto-update checks, LSP downloads, and Exa all disabled.
7. **Prompt sent through stdin** — session content never appears on the command line.
8. **No shell interpolation** — the OpenCode binary is spawned directly as an argv array with
   `shell: false`, and model names are validated before being placed in argv.

**What this does not guarantee:** this is application-level isolation, not an OS sandbox.
OpenCode is still a trusted local program running as your user, and system-managed OpenCode
configuration may have higher precedence than user configuration. For a hard
process/filesystem/network boundary, run the memory worker inside an OS/container sandbox as
well.

Tool isolation also does **not** make a remote model local: if `CLAUDE_MEM_OPENCODE_MODEL`
selects a hosted/free model, the observation/summarization text (which can include source code,
file paths, tool inputs/outputs, architecture details, logs) is sent to that model's provider
through OpenCode. Use a hosted model only if that data handling is acceptable for the project;
configure a local model/provider in OpenCode for private work.

## Configuration

Non-interactive installer path (skips claude-mem account/OAuth setup, since OpenCode owns
provider auth):

```bash
npx claude-mem install --provider opencode --model provider/model
```

Or set directly in `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_PROVIDER": "opencode",
  "CLAUDE_MEM_OPENCODE_MODEL": "provider/model",
  "CLAUDE_MEM_OPENCODE_PATH": "/absolute/path/to/opencode"
}
```

`CLAUDE_MEM_OPENCODE_PATH` is optional (defaults to `opencode` on PATH). If
`CLAUDE_MEM_OPENCODE_MODEL` is empty, OpenCode chooses its default model; set it explicitly for
predictable cost. It may be a comma-separated list (`a/x,b/y`): models are tried in order and a
rate-limited, overloaded or server-erroring model falls back to the next. Run `opencode models` to see model IDs available in your installed OpenCode.

`CLAUDE_MEM_MAX_CONCURRENT_AGENTS` (default `2`) caps concurrent Claude SDK agent subprocesses
and also bounds concurrent Kilo/OpenCode summarizer processes spawned by this provider.

Note: there is no `CLAUDE_MEM_REDACT_SECRETS` setting — secret redaction (`src/utils/redact-secrets.ts`)
runs unconditionally on data bound for the observer LLM, SQLite, and Chroma.

## What this fork deliberately does not change

It does **not**: install a Claude-Mem plugin into OpenCode, modify `~/.config/opencode/AGENTS.md`,
register Claude-Mem MCP inside OpenCode, use OpenCode as the session-capture host, auto-approve
permissions, use `--auto` or `--dangerously-skip-permissions`, or give the summarizer filesystem
or shell access. The primary host remains Claude Code.

## Upstream relationship

The intent is to keep this fork easy to rebase on
[thedotmack/claude-mem](https://github.com/thedotmack/claude-mem): the OpenCode functionality is
isolated to one provider (`src/services/worker/OpenCodeProvider.ts`, `src/services/worker/opencode/`)
plus small dispatch/wiring changes, rather than a second full host integration. If an equivalent
secure provider is accepted upstream, this fork should ideally become unnecessary.

## Backfilling historical Claude Code transcripts

Claude-Mem normally captures Claude Code sessions live, through hooks. To retroactively ingest
transcripts from sessions that happened before Claude-Mem was installed (or while it was
disabled), this fork adds a `claude-code` transcript-watch schema that replays the existing
`~/.claude/projects/<encoded-path>/*.jsonl` files through the same engine used for Codex/Cursor/Grok Bot.

1. Copy `transcript-watch.claude-code.example.json` and edit its `watches[0].path` to point at
   one project's transcript directory (the placeholder is
   `~/.claude/projects/-home-USER-dev-PROJECT/*.jsonl`; the encoded directory name is your `cwd`
   with `/` replaced by `-`).
2. Run the watcher against that config:

   ```bash
   bun plugin/scripts/transcript-watcher.cjs watch --config /path/to/your-backfill-config.json
   ```

   (equivalently `claude-mem transcript watch --config ...` for an installed `claude-mem` build).
3. `startAtEnd: false` in the example config replays every line from offset 0, so the whole
   history gets ingested. Progress is recorded per-file in the config's `stateFile`
   (`~/.claude-mem/transcript-backfill-state.json` by default), so a rerun resumes rather than
   re-ingesting from the start.
4. **Stop the watcher (Ctrl-C) once it has caught up.** It has no notion of "backfill done"; left
   running alongside the live Claude Code hooks, it will keep tailing the same files and
   double-ingest every new session going forward.
5. Session summaries queued by the backfill go through whatever `CLAUDE_MEM_PROVIDER` is
   configured for the worker (`claude` by default) — the backfill does not change or bypass that
   setting.
