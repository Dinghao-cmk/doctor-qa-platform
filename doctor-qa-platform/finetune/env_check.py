import sys
try:
    import torch
    print('torch:', torch.__version__, 'cuda:', torch.cuda.is_available())
except Exception as e:
    print('torch 导入失败:', e)
    sys.exit(1)
try:
    from unsloth import FastLanguageModel
    print('unsloth 导入 OK')
except Exception as e:
    print('unsloth 导入失败:', type(e).__name__, str(e)[:500])
    sys.exit(1)
