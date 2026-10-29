# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**). Please do not open a public issue for a security problem. We acknowledge reports as we see them; Foundry is maintained in service of Joynt's own use, so we do not promise a response time, but a report that affects anyone running Foundry will be handled before other work.

## What to know before running Foundry

Foundry runs a coding agent inside your GitHub Actions job. The trust boundary is the same as CI's, and the [security model](docs/foundry/overview.md#security-model) in the overview describes it: who may start a run, what the agent can reach, how issue text is handled, and where secrets go.
