import inspect
from trl import SFTConfig
sig = inspect.signature(SFTConfig.__init__)
for k, v in sig.parameters.items():
    if k == 'self':
        continue
    d = v.default
    print(f'{k} = {d if d is not inspect.Parameter.empty else "REQUIRED"}')
