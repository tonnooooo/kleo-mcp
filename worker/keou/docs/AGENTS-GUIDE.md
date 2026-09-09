# Using your own assistant

The engine is provider-independent. Its interface is files and terminal commands. You do not need to add a model API key to the engine.

| Environment | How to use the kit | Actual requirement |
|---|---|---|
| Claude Code | Open the folder; ask it to read CLAUDE.md and AGENTS.md | Local terminal/file access |
| Codex desktop or CLI | Open/select the extracted folder as the project; read AGENTS.md | Local execution with your account/config |
| OpenCode | Start from this folder; explicitly ask it to read AGENTS.md | Terminal/file tools on the host |
| Other coding agents | Paste START-HERE and identify the project directory | Ability to execute the documented CLI |
| Browser-only chat | Use it to write a script/project, then execute locally yourself | It cannot control your computer by text alone |

These are integration instructions, not a claim of completed UI testing in every named application. Names do not imply affiliation or endorsement. The portable command workflow is the compatibility layer.

## Example request

“Read AGENTS.md. Make a 45–60 second English video about why the Milky Way’s black hole does not swallow us. Use the exact editorial look of the approved sample, original diagrams and verified NASA facts. Prepare the project, inspect its layout, then render within 1 USD and 60 minutes on my Vast account. Return the verified MP4; do not publish.”

## Working permissions

Allow local reading/writing in the extracted folder and normal SSH/rsync/Vast operations for your authorized job. Your agent's own tool permissions still apply. Do not bypass a blocked tool by pretending that a video exists. Installation and account setup can be done manually once.

## Reusable context

Keep AGENTS.md with the project. Store the brief, final narration, sources and assets inside each unique project folder. Do not rely on a prior chat remembering which engine version or reference you liked. The renderer checks release.json before production.
