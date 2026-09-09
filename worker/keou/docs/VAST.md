# Dedicated worker, costs and recovery

## Ownership

The controller creates a fresh job label and writes `runs/<job>/state.json`. Cleanup requires this registry identity, the expected label and absence from protected_instance_ids. It never selects an existing unrelated instance for rendering. Credentials remain on the controller; only allowlisted engine files, script and assets are sent.

The default worker uses PyTorch 2.8.0 with CUDA 12.8 on a compatible single NVIDIA GPU (8 GB+), sufficient CPU/RAM and a 25 GB disk. The host is Linux amd64. Offers must match the controller filters and be below 0.30 USD/hour by default. Availability is external and can change.

## Budget model

`--budget 1 --minutes 60` means a maximum admitted estimate of 1 USD for the configured rental window plus a transfer allowance. It is **not a hard billing cap** at Vast. The controller checks credit when the API provides it. Actual billing depends on provider rates, downloads, uploads, disk and time. Use the Vast billing page for the final charge; do not advertise a fixed pennies-per-video price from a single run.

A separate watchdog requests a stop at the deadline. It only works while the local machine is awake, online and able to call Vast. The worker also gets a process timeout, which terminates the job but does not itself cancel provider billing. A stopped worker still has billable storage until destroyed.

## Recovery

```bash
python keou.py status
python keou.py resume runs/keou-job-.../state.json
```

Resume uses the same worker and original deadline, preserving remote voice/render caches. It refuses if less than about three minutes remain. The two frame segments are reused only when their fingerprints, frame counts and geometry match. Never delete a registry file to bypass duplicate-rental protection.

If the renderer fails, logs and partial project files are fetched where possible and the worker is stopped. Inspect the project's run.log and the job bootstrap.log. Fix the concrete content/environment issue, then resume within the deadline. Invalid content must pass check again.

If download succeeded but deletion confirmation failed, inspect the inventory and resume. A verified local delivery can be finalized after the worker is already gone. A successful cleanup requires verified local hashes:

```bash
python vast_worker.py cleanup runs/keou-job-.../state.json --destroy
```

For a failed job without a deliverable, this automatic destroy command intentionally refuses. Retrieve the useful files with the recorded SSH route, stop the job if needed, and use the Vast console to delete that exact owned instance after the operator decides the saved data is sufficient. Do not forge a delivery manifest. Record the final external state.

CLI mutation responses can be empty even on success; the controller checks inventory. An empty inventory response is an error, not proof that there are no machines. If instance creation returns an ambiguous response, inspect the recorded job label in the console before doing anything else.

Official references: [Vast CLI](https://docs.vast.ai/cli/hello-world), [create instance](https://docs.vast.ai/cli/reference/create-instance).
