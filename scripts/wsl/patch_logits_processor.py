import os

path = os.path.expanduser("~/qwen-serving/venv/lib/python3.12/site-packages/vllm/model_executor/layers/logits_processor.py")
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

target = """def _topk(scores: torch.Tensor, k: int) -> tuple[torch.Tensor, torch.Tensor]:
    impl = _flashinfer_topk()
    if impl is None or not scores.is_cuda:
        return torch.topk(scores, k, dim=-1)
    return impl(scores, k, sorted=True, deterministic=True)"""

replacement = """def _topk(scores: torch.Tensor, k: int) -> tuple[torch.Tensor, torch.Tensor]:
    import shutil
    if shutil.which("nvcc") is None:
        return torch.topk(scores, k, dim=-1)
    impl = _flashinfer_topk()
    if impl is None or not scores.is_cuda:
        return torch.topk(scores, k, dim=-1)
    try:
        return impl(scores, k, sorted=True, deterministic=True)
    except Exception:
        return torch.topk(scores, k, dim=-1)"""

if target in content:
    content = content.replace(target, replacement, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("SUCCESS: Patched logits_processor.py")
else:
    print("WARNING: target not found, checking if already patched...")
    if "shutil.which(\"nvcc\") is None" in content:
        print("ALREADY PATCHED!")
    else:
        raise RuntimeError("Failed to find target in logits_processor.py")
