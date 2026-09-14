"""导出官方 NomosUni SPAN 2×；校验权重与动态尺寸输出，不把权重提交进仓库。"""
import argparse
import hashlib
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
import spandrel
import torch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("weights", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
assert hashlib.sha256(args.weights.read_bytes()).hexdigest() == "a3d35e01b8b71b4b3041ad1686f8ebd7bc4e1f3a10378319c2ac61c78b67012a", "官方权重哈希不匹配"
if args.output.exists():
    parser.error("输出已存在，拒绝覆盖")
torch.set_num_threads(2)
descriptor = spandrel.ModelLoader().load_from_file(args.weights).eval().to("cpu")
assert descriptor.scale == 2 and descriptor.architecture.id == "SPAN"
model = descriptor.model
args.output.parent.mkdir(parents=True, exist_ok=True)
with torch.inference_mode():
    # SPAN 首次 forward 合并重参数卷积；先预热，避免导出时修改权重状态。
    model(torch.zeros(1, 3, 64, 64))
    torch.onnx.export(model, torch.zeros(1, 3, 64, 64), str(args.output),
        dynamo=False, opset_version=17, input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {2: "height", 3: "width"},
                      "output": {2: "out_height", 3: "out_width"}})
graph = onnx.load(args.output)
onnx.checker.check_model(graph)
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(args.output), options, providers=["CPUExecutionProvider"])
for h, w in [(64, 64), (48, 80)]:
    sample = np.random.default_rng(0).random((1, 3, h, w), dtype=np.float32)
    with torch.inference_mode():
        expected = descriptor(torch.from_numpy(sample)).numpy()
        raw_expected = model(torch.from_numpy(sample)).numpy()
    actual = session.run(None, {"input": sample})[0]
    assert actual.shape == (1, 3, h * 2, w * 2)
    # Spandrel 描述器及前端显示均钳制到 0～1；同时验证未钳制的模型原始输出。
    np.testing.assert_allclose(actual, raw_expected, atol=2e-5, rtol=2e-4)
    np.testing.assert_allclose(np.clip(actual, 0, 1), expected, atol=2e-5, rtol=2e-4)
    print("验证", h, w, "最大误差", float(np.max(np.abs(actual - raw_expected))))
print("SHA256", hashlib.sha256(args.output.read_bytes()).hexdigest())
print("bytes", args.output.stat().st_size)
print("DepthToSpace", [n.name for n in graph.graph.node if n.op_type == "DepthToSpace"])
