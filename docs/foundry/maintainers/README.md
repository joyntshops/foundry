# Maintaining Foundry

Pages for whoever changes Foundry itself, human or agent. Nothing here is needed to install or use it; the user documentation starts at [the overview](../overview.md). The repository's `CLAUDE.md` lists the invariants the code keeps and the shape of the source tree, and [CONTRIBUTING.md](../../../CONTRIBUTING.md) is the entry point for a change.

- [Design notes](design-notes.md): the non-obvious decisions behind how Foundry runs, so they are not rediscovered
- [Decisions](decisions/README.md): the records of decisions that changed Foundry's shape
- [Releasing](releasing.md): how a merge becomes a published package and a tagged Action, how to test a change before merging, and what to do when a release is bad
- [The public App](public-app.md): creating and maintaining the public Foundry App; [the broker](../../../packages/broker/README.md) behind it has its own runbook
- [Open source](open-source.md): why Foundry is public and what is still open before a wider audience
