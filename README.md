# Superagent for VS Code and GitHub Copilot

Superagent runs repository tasks in persistent Copilot sessions and isolated Git worktrees. It continuously receives GitHub and Microsoft Teams requests, applies local admission policies, follows CI and reviews, and replies in the original conversation. The native supervision panel shows tickets, source context, decisions, transcripts, and versioned policy and prompts.

See the [extension guide](vscode/README.md) for setup and supported workflows. Read the [security and deployment requirements](vscode/SECURITY.md) before rollout. The extension uses the official Copilot SDK and an installed, authenticated Copilot CLI. Its service runs while the VS Code workspace host is running.

## Build

With Node 22.19 or newer, npm, and Git installed:

```sh
cd vscode
npm ci --ignore-scripts
npm run package
code --install-extension dist/vsc-superagent.vsix
```

Local tests, native editor activation, and a live Copilot session do not establish tenant approval, live GitHub/Teams delivery compatibility, or production qualification. Follow the deployment acceptance checks before enabling external delivery.

## Attribution

The ticket engine and bundled prompt defaults are adapted from the MIT-licensed [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). The original copyright and license are retained in [LICENSE](LICENSE). Microsoft Teams replaces Feishu in this extension.
