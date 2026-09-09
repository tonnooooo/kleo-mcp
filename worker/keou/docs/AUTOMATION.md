# Automation without changing the engine

## File queue

Prepare each project's content first, then:

```bash
python keou.py enqueue projects/my-topic/project.json --budget 1 --minutes 60
python keou.py work-once
```

Enqueue stores project and asset hashes. work-once processes one pending entry under a file lock. A changed project fails before rental. Completed entries do not run again; failed entries require investigation and recovery. A process killed outside Python may leave a `running` record: inspect the matching Vast job and use resume; do not blindly reset it to pending.

## n8n integration

Run n8n where an Execute Command node can reach this kit, the controller environment and the user's own credentials. In containerized or hosted n8n, these paths are not automatically visible: mount the workspace and runtime or use a controlled SSH step to a trusted controller host.

Recommended flow:

1. Receive a brief or script.
2. Have an assistant prepare facts, narration, scenes and assets.
3. Validate and inspect the prepared project.
4. Enqueue within the authorized budget.
5. Trigger a single work-once command; inspect its exit status.
6. On success, verify delivery and provide the local files to the next approved stage.
7. On failure, inspect the existing run; avoid retries that create another paid worker.

Use fixed executable/script paths in your own n8n node. Never interpolate untrusted script text into shell commands; write it to a file or pass structured data first. Ensure one controller works on a project at a time.

No n8n workflow is activated by this kit. Scheduling, volume limits and notifications are the operator's explicit configuration.

## YouTube

The output contains youtube-package.json and captions.srt. The package records language, title, description, tags and a technical thumbnail candidate. It has `publication_status: not_configured`, `privacyStatus: private` and no channel ID. It does not upload anything.

A future uploader must handle the user's channel authorization, thumbnail choice, platform rules, publication visibility and rate limits. Keep it as a separate integration so generation remains usable with any destination.
