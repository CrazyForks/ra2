"""Convert verified Nomos ONNX to FP16; keep the final rearrangement in FP32 for WASM compatibility."""
import argparse
import hashlib
from pathlib import Path
import onnx
from onnxconverter_common import float16

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
if args.output.exists():
    parser.error("输出已存在，拒绝覆盖")
assert hashlib.sha256(args.source.read_bytes()).hexdigest() == "bff599f3192122440c2b946a1a9d881ba4dc978e19a36b7dcc8fad73d70d25c0", "FP32 源哈希不匹配"
graph = float16.convert_float_to_float16(onnx.load(args.source), keep_io_types=False,
    op_block_list=[*float16.DEFAULT_OP_BLOCK_LIST, "DepthToSpace"])
onnx.checker.check_model(graph)
args.output.parent.mkdir(parents=True, exist_ok=True)
onnx.save(graph, args.output)
print("SHA256", hashlib.sha256(args.output.read_bytes()).hexdigest())
print("bytes", args.output.stat().st_size)
