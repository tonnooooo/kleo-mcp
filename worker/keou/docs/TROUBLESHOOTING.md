# Troubleshooting

| Symptom | Meaning and next action |
|---|---|
| Python or fcntl import error | Use Python 3.11+ on POSIX; use WSL2 on Windows. |
| vastai command missing | Activate .venv-controller or rerun setup-host.sh. |
| Vast SSH key missing | Run configure-vast.py or correct ssh_key; keep both key files. |
| Authentication fails | Check your own CLI credentials and API permissions; never paste keys into a support log. |
| No matching offer | Availability/rate filters currently have no candidate. Inspect offers; change the budget/rate only deliberately. |
| Credit below budget | Fund the account or explicitly choose a smaller scope. |
| Worker loading | A fresh ML image can take 10–20 minutes. Inspect state/logs; do not start another job. |
| Worker not ready after timeout | Job should stop; inspect its recorded provider state and resume within deadline after fixing setup. |
| Production source changed since freeze | Code differs from release.json; restore it or perform a verified maintenance release. Do not delete the check. |
| Narration differs from supplied script | Synchronize script_file and scene voice text; preserve the user's exact authorized narration. |
| Speech review required | Inspect cached ASR and the actual audio. Correct spelling/pronunciation or rewrite only with authorization; do not lower the threshold. |
| Caption too brief | Adjust the sentence break or voice speed. Rerender that changed project using the existing job. |
| Layout overflow | Shorten the title or diagram labels; split the idea across scenes. |
| Existing worker needs recovery | Use status and resume the recorded job; do not erase the registry. |
| Remote job complete but transfer failed | Keep the worker/data and resume within its deadline. Verify hashes before deletion. |
| Stopped_after_failure | Compute is stopped, disk may still be billed. Follow docs/VAST.md. |
| Relative paths or spaces fail in your own wrapper | Pass argument arrays or properly quoted paths. Use a real extracted folder, not files viewed inside a zip. |

Collect only a sanitized report: OS, Python/Node versions, package version, project ID, failed stage and nonsecret error excerpt. Remove credentials, home-directory paths, SSH details, billing data and account identifiers before sharing logs. Include script/assets only when you have permission to share them.
