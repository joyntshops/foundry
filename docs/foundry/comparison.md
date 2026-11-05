# Foundry and `claude-code-action`

[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) runs Claude Code inside a GitHub Actions job when someone mentions `@claude` on an issue or pull request, or on a trigger the workflow defines. It bills the user's own Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN` or an API key, runs on whatever `runs-on` the workflow names, and can read the thread, edit files, commit, push, and open or review pull requests. It acts as one public GitHub App through a hosted token exchange; Foundry does the same.

Foundry runs the same way and bills the same way, and its `claude-code` preset is the same CLI. The difference is the layer:

| | `claude-code-action` | Foundry |
|---|---|---|
| Unit of work | one mention, one job, one reply | a task with a lifecycle that spans many jobs: claimed, running, waiting, PR open, done |
| What starts it | any `@claude` mention | three commands, authorized against repo permission; every other comment is context |
| Before a PR exists | whatever the agent chose to run; its push is the result | your verify commands must pass, enforced by Foundry; a failed run is posted on the issue and no PR opens |
| Previews | none | per-branch preview up on PR, redeploy on push, down on merge; `verify_preview` runs against it |
| Review | the agent can review | approve → rebase onto the integration branch → wait for checks → merge; siblings that now conflict get their agent back |
| Branch model | whatever the agent does | feature → integration → production, named per repo |
| Outcome | the agent's reply | a typed report (done, needs input, plan ready, blocked); control flow never reads prose |
| The agent | Claude Code | any CLI that can write the report; Claude Code is a preset |
| State | none between jobs | rebuilt from the issue each job: labels, claim comment, status comment, PR |

Use `claude-code-action` when a mention-and-reply is the whole job: answer a question, review a diff, make a one-off change. Use Foundry when the issue is a task that has to come out the other end as a verified, previewed, merged pull request and a stakeholder needs to steer it on the way.

Both are MIT-licensed and public. Foundry's source, issues and contribution notes are at [github.com/joyntshops/foundry](https://github.com/joyntshops/foundry).
