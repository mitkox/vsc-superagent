# Superagent for VS Code and GitHub Copilot

Superagent is a local VS Code extension for managing approved repository tasks with GitHub Copilot. It provides isolated Git worktrees, ticket state and follow-ups, plus read-only GitHub and Microsoft Teams inboxes. An operator approves each imported request and controls work in Copilot.

See the [extension guide](vscode/README.md) for setup, supported workflows, and polling limits. Read the [security and deployment requirements](vscode/SECURITY.md) before rollout. Local tests do not establish tenant approval, live provider compatibility, or production qualification.

## Build

With Node 22.19 or newer, npm, and Git installed:

```sh
cd vscode
npm ci --ignore-scripts
npm run package
code --install-extension dist/vsc-superagent.vsix
```

## Attribution

The ticket engine is adapted from the MIT-licensed [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). The original copyright and license are retained in [LICENSE](LICENSE).
