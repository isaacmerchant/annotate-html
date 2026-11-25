# annotate-html

Lets a reviewer leave feedback directly on an HTML page, then turns that feedback into edits.

## What it does

- Runs a small local proxy that injects an annotation overlay into an HTML file's folder, or into
  a running local app (optionally starting it), as pages are served. The app is never modified.
- Reviewers can pin elements, select text, mark areas and add page notes, each tagged as a
  Problem, Suggestion, Question or Like.
- **Send to agent** (the → 🤖 button, shown when the agent launches it with `--agent`) hands the feedback straight to the agent session (the proxy saves it and exits, which wakes the
  agent). The tab waits and reloads into the next round when the agent relaunches the proxy after its edits.
  The overlay stays on top of modal dialogs and popovers. Feedback can also be exported as text or JSON and pasted (or pointed to) in the agent chat.
- The agent groups feedback by page and element, proposes changes, and edits the **original**
  file only after the user agrees.

## Why

Feedback on prototypes usually arrives as vague screenshots and emails. Anchoring comments to the
actual elements makes them specific and actionable, with no install needed. Works for static
prototypes and for server-backed apps alike.

## Install

Clone this repo, then link it into the shared skills folder and from there into each agent's own
skills folder. One copy then serves every agent, and a `git pull` updates them all.

```shell
git clone https://github.com/isaacmerchant/annotate-html.git ~/Developer/annotate-html
ln -sfn ~/Developer/annotate-html ~/.agents/skills/annotate-html
for d in ~/.claude/skills ~/.config/opencode/skills ~/.codex/skills ~/.cursor/skills ~/.gemini/skills; do
  mkdir -p "$d" && ln -sfn ~/.agents/skills/annotate-html "$d/annotate-html"
done
```

Agents: Claude Code (`~/.claude/skills`), OpenCode (`~/.config/opencode/skills`), Codex (`~/.codex/skills`),
Cursor (`~/.cursor/skills`) and Gemini CLI (`~/.gemini/skills`). Restart an agent, or start a new session,
to pick up a newly installed skill. Copying the folder instead of linking also works.

Requirements: Python 3.9+ and a browser.

## Contents

- `SKILL.md`: the agent instructions.
- `scripts/annotate.py`: serves a file or proxies a URL (`--cmd` to start the app), injecting the overlay.
- `assets/annotator.js`: the overlay, injected into each HTML response.

## Setup

Needs Python 3. No other dependencies.

## Notes

- Pairs naturally with the `prototype` skill.
- Comments live in browser `localStorage` until sent or exported. Sent feedback is saved to a temp folder (`--out` to change).
