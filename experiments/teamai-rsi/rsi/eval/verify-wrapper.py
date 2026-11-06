#!/usr/bin/env python3
"""TeamAI command-step wrapper. Install as rsi/verify.py, suite in rsi/eval/."""
import importlib.util
import json
import os
from pathlib import Path
import sys


def main():
    suite = Path(__file__).resolve().parent / "eval"
    spec = importlib.util.spec_from_file_location("rsi_frozen_score", suite / "score.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    taskpack = Path(os.environ["RSI_TASKPACK"]).resolve()
    allowed = {(suite / split / "tasks.json").resolve(): split for split in ("dev", "holdout")}
    if taskpack not in allowed:
        raise ValueError("RSI_TASKPACK must name one of the frozen dev/holdout task files")
    responses = module.strict_json(os.environ["RSI_RESPONSES_JSON"])
    expected_hash = os.environ.get("RSI_EVAL_MANIFEST_SHA256")
    result = module.evaluate_payload(allowed[taskpack], responses, root=suite,
                                     expected_manifest_sha256=expected_hash)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["report"]["integrity_pass"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"error": {"code": "verification_error", "message": str(exc)}}, ensure_ascii=False))
        raise SystemExit(2)
