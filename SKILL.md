---
name: annotate-html
description: Launch the annotation overlay on an HTML file or a running local app (Flask, Node, `python server.py`, etc.) so the user can pin elements, select text, mark areas and leave page notes in the browser, then turn their exported feedback into edits. Use when the user wants to annotate, review or give feedback on an HTML file, prototype or local web app.
---

# Annotate HTML

Lightweight: no install, the app is never modified. A small local proxy injects the overlay into the HTML as it is served. Feedback comes back one of two ways: the reviewer presses **Send to agent** (the proxy saves it, prints it and exits, which wakes you), or they copy or save it and paste it or give you the path.

## Steps

1. **Work out the target.**
   - A static prototype: the path to the original `.html`.
   - An app that is already running: its URL, e.g. `http://127.0.0.1:8765`.
   - An app that needs starting: find the launch command (README, `server.py`, `package.json`) and the port it listens on. Ask if unclear.
2. **Launch** in the background (it keeps running until the reviewer sends feedback). Running it in the background matters: its exit is how Send to agent reaches you.
   ```
   python "<skill folder>/scripts/annotate.py" "<file.html>" --agent
   python "<skill folder>/scripts/annotate.py" http://127.0.0.1:8765 --agent
   python "<skill folder>/scripts/annotate.py" 127.0.0.1:8765 --agent --cmd "python server.py --port 8765" --cwd "<app folder>"
   ```
   - Always pass `--agent` when you launch it: it shows the **→ 🤖** (Send to agent) button, which only makes sense while you wait on the process. A person running the script by hand omits it and exports instead.
   - File mode serves the file's folder, so sibling pages, assets and links just work.
   - `--cmd` starts the app, waits for the port, and stops it when the proxy exits (also if the proxy is killed).
   - It prints the annotated URL (default port 8766, next free port if busy) and opens it. Flags: `--no-open`, `--port N`, `--project NAME`, `--cwd DIR`, `--keep-comments`, `--out DIR` (where sent feedback is saved; default `<temp>/annotate-html`).
   - Note the port it printed; the next round must reuse it.
3. **Tell the user how to use it**, briefly:
   - Toolbar: Pin (click an element), Text (select text), Area (drag a box), Page note.
   - Optionally set a type: Problem / Suggestion / Question / Like.
   - When done: the **→ 🤖** button, Send to agent (the tab then waits and reloads into the next round by itself). Or **Export ▾** then **Copy as text** (paste it here) or **Save as text/JSON file…** (tell you the path).
4. **Wait** for the feedback. Do not poll or guess. If the background process exits with `FEEDBACK SENT: <path>`, the feedback follows in its output (the same text is in that file, with JSON alongside). Exiting any other way means it stopped or crashed; say so.
5. **Act on it** once it arrives (pasted or read from the path):
   - Group by page, then by element. Read the selector, text, component and classes to find each element in the **source** (for server apps, the templates or front-end files, not the served HTML).
   - Never invent facts. If a comment is vague ("don't like this") or an element can't be found, list it as an open question instead of guessing.
   - Propose the changes first, then edit the source only after the user agrees.
   - Never write to Jira or GitHub without explicit confirmation.
6. **Next round.** After the edits, relaunch in the background with the same target, `--agent`, the **same `--port`** and `--no-open`: the waiting tab spots the new launch and reloads by itself, and the user reviews again. If the feedback was pasted instead, the proxy is still running: a reload shows file edits, but relaunch anyway so the round starts blank.
7. **Clean up.** Stop the background process when the review is finished. Each launch clears the saved comments in the browser, so the next round starts blank. Pass `--keep-comments` to carry comments over. Sent feedback files stay in the `--out` folder.

## Notes and limits

- Comments are kept in the browser (`localStorage`) per origin and project slug until sent or exported, so send or export before closing. Reloading keeps them; relaunching `annotate.py` clears them (each launch carries a new run id; `--keep-comments` disables this). A different port is a different origin, so it has its own comments.
- The default slug is the folder name (file mode) or `host-port` (URL mode). Use `--project` to group several runs.
- The page is identified by its file name, so every route of a single-page app that serves `index.html` shares one page id. Data-driven content (tables, charts) is re-found by selector then text, which can drift after filtering or sorting. Add `data-annot-id` to elements that matter.
- Modal `<dialog>`s and page popovers are covered: the overlay joins the browser's top layer and moves into an open modal, so the toolbar and pins stay on top and clickable. Esc closes the overlay's own UI first, not the page's dialog.
- Pins on `position: fixed` elements drift on scroll.
- Not handled: websockets, and apps that enforce strict origin or CORS checks against the original port.
- Old `.annotated.html` copies are no longer produced. Delete any left over from earlier runs.
- Save As needs Chrome or Edge. Other browsers download the file instead.
- Works with Claude Code and any agent that reads `SKILL.md` skills. Install by linking or copying this folder into the agent's skills directory.
