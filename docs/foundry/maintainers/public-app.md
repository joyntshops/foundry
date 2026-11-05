# The public Foundry App

How the public App that installers use is created and maintained. Installers never need this page; they install the App from [its page](https://github.com/apps/joynt-foundry/installations/new) and are done. The reasoning is in [the decision record](decisions/2026-11-03-public-app-token-broker.md); the broker it depends on has its own [runbook](../../../packages/broker/README.md) for deploying, rotating the key and the kill switch.

## Creating it

```bash
foundry setup-bot --public --org joyntshops --name "Joynt Foundry"
```

One browser click creates the App with `public: true` and every permission Foundry needs ([permissions reference](../github-backends.md#permissions-reference)), saves the private key to `~/.joynt-foundry/public-app-joyntshops.pem` (mode 0600), checks the granted permissions, and prints the steps GitHub has no API for:

1. **Logo.** On the App's settings page under *Display information*, upload [`packages/foundry/assets/foundry-bot.png`](../../../packages/foundry/assets/README.md).
2. **Public.** The manifest asks for it; the *Advanced* tab confirms it (the button reads *Make private* when the App is public).
3. **Broker.** The printed `aws secretsmanager create-secret` line stores the key, `scripts/deploy.sh` deploys with the App ID, then the local `.pem` is deleted. [`packages/broker/README.md`](../../../packages/broker/README.md) is the runbook.
4. **Links.** The broker URL becomes the `broker-url` default of `action.yml` and `broker-token/action.yml`; the install link goes into Onboarding. For the joyntshops App (`joynt-foundry`) these are `https://tfmj7duxeutstzy3usrv6uch2q0rtwkg.lambda-url.us-west-2.on.aws/` and `https://github.com/apps/joynt-foundry/installations/new`.

Running the command again prints the same steps for the saved App without creating another.

## Maintaining it

- **Permissions.** The App's permission set is the ceiling for every installation. When Foundry needs a new permission, add it on the App's settings page; GitHub then asks every installer to accept the update, and jobs on an installation that has not accepted keep the old set; the installer accepts it under *Installed GitHub Apps → Configure*. `foundry setup-bot --check` with the App's ID and key reports which installations lag ([GitHub Identity](../github-backends.md#creating-a-self-owned-app-foundry-setup-bot)).
- **Key rotation and the kill switch** are in the broker runbook.
- **Who is installed.** `gh api app/installations` with an App JWT lists every installation; the broker's log records every exchange, allowed or refused, by repository.
