---
name: learn
description: Open a visual, interactive lesson in the browser about a topic the user wants to learn, taught by a separate Claude Code session with animations, diagrams, code walkthroughs and quizzes. The lesson is saved so it can be reopened any time. Use only when the user explicitly runs /learn or asks to "learn"/"teach me" something in the browser or the visual tutor.
argument-hint: "<topic>"
allowed-tools: Bash(learn:*), Bash(*/bin/learn:*), Bash(mktemp:*), Write
---

# /learn

Start a browser lesson about `$ARGUMENTS`.

1. **Topic.** Use `$ARGUMENTS`. If it's empty, take the topic from what the user is currently working on in this conversation. If there's no clear topic, ask for one in a single short question.
2. **Context handoff.** Write a summary of at most 120 words that helps a tutor start at the right level. Cover:
   - what the user is building or doing right now;
   - the relevant files or paths;
   - what they already seem to know.

   Write it to a temp file. Use `mktemp` for the path, then the Write tool for the contents. Skip this step if the conversation has no useful context.
3. **Launch.** From the current working directory, run:
   ```
   learn "<topic>" --context-file <file>
   ```
   If `learn` isn't on PATH, run `"${CLAUDE_PLUGIN_ROOT}/bin/learn"` instead.

   Optional flags:
   - `--scratch` when the topic has nothing to do with this project;
   - `--model <name>` if the user asked for a specific model.
4. **Report.** Tell the user, in one line, that the lesson opened in their browser, and give the `learn --resume <id>` command the CLI printed. Do not teach the topic here: the browser session does that.

Other commands you can run when the user asks:
- `learn --library` lists past lessons.
- `learn --resume <id>` reopens a lesson.
- `learn stop` stops the background server.
