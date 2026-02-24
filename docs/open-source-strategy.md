# Open-Source Strategy: Joynt Foundry

*Internal strategy memo — Joynt leadership*
*February 2026 | Foundry v0.1.17*

---

## 1. What Foundry Actually Is

Foundry is a developer automation system that turns GitHub Issues into validated pull requests. It is not a coding agent — it is the **orchestration layer** that makes coding agents useful in production.

The core loop: poll GitHub for issues labeled `state:ready`, claim one atomically, create an isolated git worktree, launch a pluggable coding agent inside a tmux session, wait for the agent to finish, run a verification pipeline (lint, typecheck, build, tests), and open a PR targeting an `integration` branch. Humans review the PR. Foundry handles everything else.

As of v0.1.17, Foundry is a TypeScript CLI (`@joyntshops/foundry`) with ~1,200 lines of core logic across 18 source files. It ships as an npm package. Dependencies are minimal: `@octokit/rest`, `commander`, `chalk`, `yaml`, and `@octokit/auth-app`. No frameworks. No database. State lives in flat JSON files under `~/.joynt-foundry/` with atomic writes.

What it does today:

- **Concurrent agent sessions** — up to N tasks in parallel, each in its own worktree and tmux session
- **Pluggable agent backends** — Claude Code, aider, Cursor, or any CLI command. No code changes needed to add a new agent.
- **Atomic claim protocol** — label swap + structured comment + verification read-back to prevent double-claims across multiple runners
- **Verification pipeline** — configurable, fail-fast sequence of shell commands before any PR is created
- **Human-in-the-loop** — agent questions are posted to the GitHub issue/PR; human replies are detected and the agent is resumed automatically
- **PR review feedback loop** — `CHANGES_REQUESTED` reviews and review comments are fed back to the agent, which resumes to address them
- **Plan mode** — agents can run in plan-only mode, post a plan for human approval on the issue, then execute in auto mode after sign-off
- **Integration branch workflow** — moving `integration` branch collects all feature PRs, with `foundry review` for rebase-merge and `foundry release` for unified monorepo versioning
- **GitHub App auth** — `foundry setup-bot` creates a GitHub App in two clicks, with auto-managed installation tokens via `@octokit/auth-app`
- **Reconciliation on startup** — detects orphaned tmux sessions, dead agents, stale state

## 2. What Makes This Credible Engineering

If the goal of open-sourcing is to signal "we know what we're doing," these are the decisions that carry weight:

**Atomic claim protocol.** The claim sequence — remove `state:ready`, add `state:in-progress`, post a structured comment with runner ID, sleep, re-read comments, verify our claim is the latest — is a proper distributed-systems approach to avoiding double-work. It's not perfect (GitHub's API doesn't give us CAS), but it's honest about the constraints and handles the common races.

**Label-driven state machine.** Task lifecycle is explicit: `state:ready` -> `state:in-progress` -> `state:ready-for-human-review` -> `state:done`, with `state:failed`, `state:waiting-for-input`, and `state:plan-review` as side states. Every transition is backed by both a GitHub label change and a local state file update. This is auditable and debuggable — you can see where every task is by looking at your issue board.

**Pluggable backends with zero coupling.** The `AgentBackend` interface has three methods: `resolveCommand`, `resolveResumeCommand`, `resolveEnv`. That's it. Backend config is YAML. Adding a new agent means adding a YAML block, not touching Foundry's code. The `agent_label_map` lets you route specific issues to specific agents by label. This is a meaningful architectural bet: Foundry is the orchestration layer, and it explicitly declines to be an agent.

**Verification as a gate.** No PR is created until the verification pipeline passes. The pipeline is a configurable ordered list of shell commands, run in the worktree with `CI=1`, with a 5-minute timeout per step and fail-fast semantics. Verification failures are posted back to the issue with command output. This is the thing that separates "vibe-coded PR spam" from "the agent's output was validated before any human saw it."

**Atomic local state.** All state writes use write-to-temp-then-rename (`atomicWrite`). The state schema is typed (`TaskState`, `RunnerState`). State files are keyed by repo. Corrupted state files are detected and recovered from. This is a small thing, but it's the kind of thing that shows you've shipped software before.

**Worktree isolation.** Each task gets its own git worktree. Agents can't interfere with each other or with the developer's main checkout. Worktrees are cleaned up on task completion. The `foundry prune` command handles stale worktrees from crashed sessions.

**Agent outcome analysis.** The `agent-output.ts` module parses Claude Code's stream-json NDJSON log format, extracts session IDs for resume, detects `AskUserQuestion` tool calls, and uses a multi-signal heuristic (commits beyond base + message pattern matching) to classify outcomes as completed, needs-input, errored, or indeterminate. It handles the ambiguity of LLM output honestly — the `indeterminate` type exists because sometimes you genuinely can't tell.

**Pluggable GitHub backends.** Both `gh` CLI and `@octokit/rest` are supported as GitHub API clients, with the same abstract interface. The `gh-cli` path requires zero config. The `octokit` path enables GitHub App auth with auto-refreshing tokens. Resolution order is explicit: CLI flag > env var > config file > auto-detect > default.

## 3. Competitive Landscape

| Tool | What it is | How Foundry differs |
|------|-----------|---------------------|
| **Devin** | Full autonomous agent + cloud sandbox | Foundry is the orchestrator, not the agent. Runs locally, uses your existing tools. No vendor lock-in to a specific AI. |
| **SWE-agent** | Research framework for agent benchmarks | Research tool, not production infra. No issue tracking integration, no verification pipeline, no PR workflow. |
| **OpenHands** | Open-source Devin-style agent + sandbox | Agent-first, not orchestration-first. Foundry is agent-agnostic by design. |
| **Sweep** | AI-powered PR generation from issues | Closest competitor in concept. But Sweep is a hosted SaaS with its own agent. Foundry is self-hosted, pluggable, and verification-gated. |
| **Copilot Workspace** | GitHub's native spec-to-PR tool | Tied to GitHub's ecosystem and AI. No pluggable backends. No verification pipeline. No integration branch workflow. |
| **aider** | Terminal-based AI pair programmer | aider is an agent, not an orchestrator. Foundry can use aider as a backend. They're complementary, not competitive. |

**What's genuinely different:**

1. **Agent-agnostic orchestration.** Every competitor is either an agent or tightly coupled to one. Foundry is explicitly the layer above the agent. Swap Claude for GPT-5 next month by changing a YAML block.
2. **Verification as a first-class concept.** Most tools hand you a PR and hope for the best. Foundry gates on lint/typecheck/build/test before the PR exists.
3. **GitHub Issues as the control plane.** No new UI, no SaaS dashboard. Your existing issue tracker is the interface. State is visible on the issue board.
4. **Human-in-the-loop with automatic resume.** The agent can ask questions, they get posted to GitHub, and when a human replies, the agent resumes. This isn't a demo feature — it's a production workflow backed by session persistence.

**What's table stakes (not a differentiator):**

- Running an agent on a codebase
- Creating PRs from agent output
- Branch isolation
- Concurrent tasks

## 4. What to Open-Source

Everything. Foundry is an internal tool we built to ship Joynt's products faster. There is no SaaS play, no open-core model, no proprietary layer to protect. The entire codebase goes public:

- The runner loop (poll, claim, spawn, verify, PR)
- The claim protocol
- The verification pipeline
- The agent backend interface and command backend
- The state management layer
- The git/worktree/tmux operations
- The agent output parser
- The human-in-the-loop machinery
- The PR review feedback loop
- The plan mode workflow
- The integration branch strategy and release tooling
- The GitHub backend abstraction (gh-cli + octokit)
- The `setup-bot` command
- All CLI commands
- All documentation

There's nothing to hold back because the value to Joynt isn't in selling Foundry — it's in using Foundry to build and ship our actual products. Open-sourcing is pure upside:

1. It forces us to keep the code clean (public scrutiny is a feature)
2. Community contributions improve the tool we depend on daily
3. It's the single best proof that Joynt is a real engineering company, not a wrapper around ChatGPT

## 5. Pre-Launch Checklist

### License
- [ ] Choose license: **Apache 2.0** (recommended — permissive, patent grant, standard for infrastructure tools; used by Kubernetes, Terraform, etc.)
- [ ] Add `LICENSE` file to repo root
- [ ] Update `package.json` license field from `UNLICENSED` to `Apache-2.0`

### Repo cleanup
- [ ] Audit for hardcoded Joynt-internal references (org names, URLs, internal tool names)
- [ ] Remove or redact any internal config examples that reference private repos
- [ ] Ensure `.gitignore` covers `~/.joynt-foundry/` state, `.pem` files, and any local config
- [ ] Verify no secrets, tokens, or private keys have ever been committed (`git log -p --all -S "ghp_"`, etc.)
- [ ] Remove or clean up the `.claude/` directory if it contains session-specific state
- [ ] Confirm all npm dependencies are permissively licensed (no GPL surprises)

### README rewrite
- [ ] Current README is functional but internal. Rewrite for an external audience:
  - Lead with the problem statement (agents produce PRs, but who validates them?)
  - Show the demo flow in 30 seconds (issue -> label -> PR appears)
  - Architecture diagram
  - Quick start that works on a fresh repo
- [ ] Add badges: CI status, npm version, license

### Community files
- [ ] `CONTRIBUTING.md` — how to add backends, run tests, submit PRs
- [ ] `CODE_OF_CONDUCT.md` — standard Contributor Covenant
- [ ] `SECURITY.md` — responsible disclosure policy
- [ ] Issue and PR templates

### CI for public
- [ ] GitHub Actions workflow: lint, typecheck, build, test on PRs
- [ ] Release automation: publish to npm on tag push
- [ ] Dependabot or Renovate for dependency updates

### Documentation
- [ ] Review all `docs/foundry/*.md` for accuracy and external readability
- [ ] Add a "Why Foundry?" page that positions it against alternatives
- [ ] Add a "Building a Custom Backend" tutorial
- [ ] Consider a docs site (Docusaurus, VitePress) for discoverability

### Final review
- [ ] Internal dogfooding for 2 weeks on a non-critical repo with the exact public version
- [ ] Get a security review of the `setup-bot` flow (it creates GitHub Apps programmatically)
- [ ] Prepare a launch blog post / announcement

## 6. Risks and Mitigations

### Competitors fork and build on it
**Risk:** Low. Foundry isn't our product — it's how we build our products. If a competitor forks Foundry and ships better software with it, that's flattering, not threatening. We still benefit from being known as the company that built the tool.
**Mitigation:** Stay the most active maintainers. Apache 2.0 requires attribution, which is brand exposure regardless of who forks.

### Support burden
**Risk:** Medium. Open-source users will file issues, expect documentation, and need help with edge cases across environments we haven't tested.
**Mitigation:** Clear CONTRIBUTING.md that sets expectations: Foundry is maintained by Joynt for Joynt's needs, and community contributions are welcome but not guaranteed a fast response. Triage labels. Don't promise response times. Review community PRs during existing Foundry maintenance cycles, not as a separate commitment.

### Premature exposure of rough edges
**Risk:** Medium-high. v0.1.17 has real rough edges:
- Agent outcome detection is heuristic-based and will misclassify (see below)
- The claim protocol has a race window (the 1-second sleep is a bandaid, not a lock)
- Error handling in some paths is best-effort with swallowed exceptions
- No tests for the runner loop itself (only unit tests for individual modules)
- The `indeterminate` outcome type is an honest admission that classification is fuzzy

**Mitigation:** Own the rough edges in the README. "This is production software with known limitations" is more credible than pretending it's polished. File issues for known problems before launch so it looks like active development, not neglect. Prioritize adding integration tests before going public.

**Detail on outcome detection:** When an agent exits, Foundry has to decide what happened. It uses a cascade of signals in `agent-output.ts`:

1. **Structured signals (reliable):** If the stream-json log contains a `result` event with `subtype: "error"`, that's an error. If the agent called the `AskUserQuestion` tool, that's needs-input. If the agent ran in plan mode, that's plan-completed. These are trustworthy because they come from the agent's own structured output.

2. **Git state (reliable):** Did the agent produce commits beyond the base branch? `git rev-list --count origin/integration..HEAD > 0` is a hard fact.

3. **Message pattern matching (unreliable):** The final assistant message is tested against two regex lists — `COMPLETION_PATTERNS` (words like "committed", "implemented", "successfully") and `NEEDS_INPUT_PATTERNS` (phrases like "could you", "unable to", "which approach"). These are checked against the *entire* final message, not parsed for sentiment or negation.

The decision tree: commits + completion keywords = completed. No commits + input keywords or trailing `?` = needs-input. Commits but no keyword match = still completed (assumes commits imply done). No commits and no clear signal = indeterminate.

Where it breaks:

- **False completed:** Agent commits partial work and says "I've implemented the login page, but I wasn't able to complete the tests — could you clarify the expected behavior?" Has commits, message contains "implemented" and "complete" — classified as `completed`. The needs-input signals ("could you", "unable to") are also present but the completion branch fires first because `hasCommits` is true. A PR gets opened for half-finished work.
- **False completed via indeterminate:** Agent produces no meaningful work, makes no commits, final message is something bland like "I've reviewed the codebase." No pattern matches, classified as `indeterminate` — which `run.ts` treats identically to `completed` (line 323-325: `case 'completed': case 'indeterminate': await handleCompleted(...)`). Verification runs, and if the empty branch doesn't break lint/build/test (it won't — nothing changed), Foundry tries to open a PR. It'll likely be an empty PR or fail at push, but the state machine still treats it as the happy path.
- **False needs-input:** Agent successfully implements everything, commits it, but ends with a conversational "Let me know if you'd like any changes?" — could be classified as needs-input on the no-commits path, though in practice the commits-exist branch would fire first and save it. More realistically: agent makes no commits because the task required only config changes that it staged but forgot to commit, and the helpful summary message ends with `?`. Classified as needs-input, posted to the issue, human is confused.
- **Negation blindness:** The regex `/\bcompleted?\b/i` matches "I have not completed this task." The pattern matching has no concept of negation. An agent that explicitly says it failed, using the word "complete" in a negative context, can be classified as completed if it also happened to make commits.

The verification pipeline catches some of these — a half-finished implementation that breaks the build won't get a PR. But incomplete work that still passes lint/typecheck/build/test is the real failure mode, and it happens regularly enough that it's the single most complained-about behavior in internal use.

### Security surface
**Risk:** Medium. The `setup-bot` command orchestrates GitHub App creation via OAuth device flow. Agent commands are shell-executed with user-provided template variables. tmux session names are derived from issue data.
**Mitigation:** Audit template interpolation for injection. Document the threat model. The `verify` pipeline runs user-configured commands in worktrees, which is already a trust boundary (you trust your own CI commands). Add a security section to docs.

### Maintenance becomes a distraction
**Risk:** Low-medium. Community PRs, feature requests, and issue triage take time away from building Joynt's actual products.
**Mitigation:** Set expectations early: Foundry is maintained in service of Joynt's needs. Community contributions are welcome but Joynt's roadmap drives priorities. A clear CONTRIBUTING.md and honest "we'll review when we can" stance prevents entitlement.

## 7. Strategic Value

**"Show me the code."** The AI/SaaS space is drowning in companies that are thin wrappers around API calls. When someone evaluates Joynt — as a customer, partner, investor, or potential hire — Foundry is the answer to "can these people actually build software?" The code speaks for itself: typed interfaces, atomic state management, honest tradeoffs, real tests. This is not vibe-coded.

**Hiring signal.** Open-source code is the best recruiting tool. Engineers can read Foundry's source before they apply. They see clean TypeScript, thoughtful architecture, and a team that ships production tooling. This is worth more than any job description or recruiter pitch.

**Credibility with customers.** Buyers evaluating Joynt's products will look at Foundry's code quality as a proxy for engineering maturity. "We built our own agent orchestration system and open-sourced it" is a fundamentally different pitch than "we use off-the-shelf tools."

**Free improvements to our own tooling.** Agent backends are the obvious community extension point. If external contributors add backends for OpenHands, Cody, or custom setups, our internal tool gets better without us lifting a finger. Bug reports from other environments catch issues before they bite us.

**Positioning Joynt in the AI development ecosystem.** The AI coding agent space is exploding but orchestration is still an unsolved mess. Being known as the company that built the orchestration layer — and gave it away because the orchestration isn't even the main thing we do — is a strong brand signal. It says "we're so far ahead that this is just our tooling."

---

*Bottom line: Foundry isn't Joynt's product — it's how Joynt builds products. Open-sourcing it costs us nothing proprietary and gains us credibility, community contributions, and a public proof point that we're a serious engineering company. The only risk is the maintenance burden, and that's manageable with clear expectations.*
