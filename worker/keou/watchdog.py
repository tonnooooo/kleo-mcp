"""Stop only this job's worker when its rental deadline expires."""
import json
import sys
import time
import os
import shutil
import subprocess
from pathlib import Path
from vast_worker import cleanup
path=Path(sys.argv[1])
if sys.platform=='darwin' and shutil.which('caffeinate'):
    subprocess.Popen(['caffeinate','-i','-w',str(os.getpid())],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
while True:
    state=json.loads(path.read_text())
    if state.get('status') in {'destroyed','stopped_after_failure'}:break
    if time.time()>=state['deadline']:
        try:cleanup(path,destroy=False);break
        except Exception as e:print('WATCHDOG_RETRY',e,flush=True)
    time.sleep(15)
