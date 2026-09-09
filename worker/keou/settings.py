"""Only user-local configuration; no credentials are stored in the kit."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def load_settings():
    config={"ssh_key":"~/.ssh/id_ed25519_keou","protected_instance_ids":[]}
    path=ROOT/'config.local.json'
    if path.exists():
        data=json.loads(path.read_text())
        if not isinstance(data,dict) or set(data)-set(config):raise ValueError('Unknown configuration keys')
        config.update(data)
    key=config['ssh_key']
    if not isinstance(key,str) or not key.strip() or not Path(key).expanduser().is_absolute():raise ValueError('ssh_key must be an absolute path or start with ~/')
    protected=config['protected_instance_ids']
    if not isinstance(protected,list) or any(type(x) is not int or x<=0 for x in protected):raise ValueError('protected_instance_ids must contain positive integers')
    return config
