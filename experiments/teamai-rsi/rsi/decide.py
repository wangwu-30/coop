#!/usr/bin/env python3
"""Fixed adoption policy for the three-round development screening cycle.

Inputs arrive through environment variables, never through shell evaluation.
This program makes no file changes. Its sole stdout value is {"decision": ...}.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any


MAX_ROUNDS = 3
MIN_NEW_COMPLETE_CASES = 1
MIN_CODEPOINT_REDUCTION_PERCENT = 15
SEMANTIC_FIELDS = (
    "observations_supported",
    "decisive_evidence_explained",
    "recommendations_proportionate",
)


class DecisionInputError(ValueError):
    """The decision cannot safely compare the supplied records."""


def object_value(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DecisionInputError(f"{name} must be an object")
    return value


def bool_value(value: Any, name: str) -> bool:
    if type(value) is not bool:
        raise DecisionInputError(f"{name} must be boolean")
    return value


def nonempty_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DecisionInputError(f"{name} must be non-empty text")
    return value


def assessment(
    verification: Any, judgement: Any, name: str
) -> tuple[dict[str, bool], dict[str, Any]]:
    hard = object_value(verification, f"{name}.verification")
    semantic = object_value(judgement, f"{name}.judgement")
    for field in ("schema_pass", "integrity_pass"):
        bool_value(hard.get(field), f"{name}.verification.{field}")
    nonempty_text(hard.get("suite_version"), f"{name}.verification.suite_version")
    nonempty_text(hard.get("split"), f"{name}.verification.split")
    cases = object_value(hard.get("case_results"), f"{name}.verification.case_results")
    semantic_cases = object_value(
        semantic.get("case_results"), f"{name}.judgement.case_results"
    )
    if not cases or set(cases) != set(semantic_cases):
        raise DecisionInputError(f"{name} hard and semantic case sets must match")
    complete: dict[str, bool] = {}
    semantic_passes: list[bool] = []
    for case_id, raw in cases.items():
        case = object_value(raw, f"{name}.{case_id}.hard")
        judged = object_value(semantic_cases[case_id], f"{name}.{case_id}.semantic")
        hard_pass = bool_value(case.get("pass"), f"{name}.{case_id}.hard.pass")
        schema_pass = bool_value(
            case.get("schema_pass"), f"{name}.{case_id}.hard.schema_pass"
        )
        semantic_pass = bool_value(
            judged.get("pass"), f"{name}.{case_id}.semantic.pass"
        )
        checks = [
            bool_value(judged.get(field), f"{name}.{case_id}.{field}")
            for field in SEMANTIC_FIELDS
        ]
        problems = judged.get("problems")
        if not isinstance(problems, list) or not all(isinstance(x, str) for x in problems):
            raise DecisionInputError(f"{name}.{case_id}.problems must be a string list")
        if semantic_pass != all(checks):
            raise DecisionInputError(f"{name}.{case_id} semantic pass contradicts checks")
        if hard_pass and not schema_pass:
            raise DecisionInputError(f"{name}.{case_id} hard pass contradicts schema")
        complete[case_id] = hard_pass and semantic_pass
        semantic_passes.append(semantic_pass)
    overall = bool_value(semantic.get("semantic_pass"), f"{name}.semantic_pass")
    if overall != all(semantic_passes):
        raise DecisionInputError(f"{name}.semantic_pass contradicts its case results")
    if hard["schema_pass"] and not all(case["schema_pass"] for case in cases.values()):
        raise DecisionInputError(f"{name}.schema_pass contradicts its case results")
    return complete, {
        "schema": hard["schema_pass"],
        "integrity": hard["integrity_pass"],
        "semantic": overall,
        "suite_version": hard["suite_version"],
        "split": hard["split"],
    }


def fingerprint(text: str) -> dict[str, Any]:
    return {
        "codepoints": len(text.strip()),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def decide(
    *,
    round_number: int,
    incumbent: str,
    baseline: dict[str, Any],
    proposal: dict[str, Any],
    verification: dict[str, Any],
    judgement: dict[str, Any],
    taskpack: str = "",
) -> dict[str, Any]:
    if type(round_number) is not int or not 1 <= round_number <= MAX_ROUNDS:
        raise DecisionInputError("round must be an integer from 1 to 3")
    incumbent = nonempty_text(incumbent, "incumbent")
    baseline = object_value(baseline, "baseline_report")
    proposal = object_value(proposal, "proposal")
    recommendation = proposal.get("recommendation")
    if recommendation not in ("change", "retain"):
        raise DecisionInputError("proposal.recommendation must be change or retain")
    nonempty_text(proposal.get("hypothesis"), "proposal.hypothesis")
    candidate = nonempty_text(proposal.get("candidate_instructions"), "candidate_instructions")
    changes = proposal.get("changes")
    if not isinstance(changes, list) or not all(isinstance(x, str) for x in changes):
        raise DecisionInputError("proposal.changes must be a string list")
    before, baseline_gate = assessment(
        baseline.get("verification"), baseline.get("judgement"), "baseline"
    )
    after, candidate_gate = assessment(verification, judgement, "candidate")
    if set(before) != set(after):
        raise DecisionInputError("baseline and candidate case sets differ")
    for key in ("suite_version", "split"):
        if baseline_gate[key] != candidate_gate[key]:
            raise DecisionInputError(f"baseline and candidate {key} differ")
    # The verifier independently checks its frozen manifest. If it also records
    # a manifest hash, do not silently compare different or missing identities.
    base_hard = baseline["verification"]
    for key in ("manifest_sha256", "taskpack_sha256"):
        if key in base_hard or key in verification:
            if not base_hard.get(key) or base_hard.get(key) != verification.get(key):
                raise DecisionInputError(f"baseline and candidate {key} differ")
    improved = sorted(k for k in before if not before[k] and after[k])
    regressed = sorted(k for k in before if before[k] and not after[k])
    base_size = fingerprint(incumbent)
    candidate_size = fingerprint(candidate)
    reduction = (base_size["codepoints"] - candidate_size["codepoints"]) / base_size["codepoints"]
    decision: dict[str, Any] = {
        "schema_version": "rsi-decision-v1",
        "round": round_number,
        "taskpack": taskpack,
        "action": "reject",
        "adopt": False,
        "valid_comparison": True,
        "reason": "no_qualifying_evidence",
        "baseline": {"complete_passed": sum(before.values()), "cases": len(before), **base_size},
        "candidate": {"complete_passed": sum(after.values()), "cases": len(after), **candidate_size},
        "gates": {"baseline": baseline_gate, "candidate": candidate_gate},
        "improved_cases": improved,
        "regressed_cases": regressed,
        "codepoint_reduction_fraction": reduction,
        "case_results": {
            k: {"incumbent_complete": before[k], "candidate_complete": after[k]}
            for k in sorted(before)
        },
        "policy": {
            "max_rounds": MAX_ROUNDS,
            "min_new_complete_cases": MIN_NEW_COMPLETE_CASES,
            "requires_no_regressions": True,
            "min_codepoint_reduction_percent": MIN_CODEPOINT_REDUCTION_PERCENT,
            "length_measure": "Python len(text.strip()), Unicode codepoints",
            "length_claim": "context_length_proxy_only_not_token_or_cost_savings",
        },
    }
    if candidate_gate["split"] != "dev":
        decision.update(reason="selection_requires_development_split", valid_comparison=False)
    elif not baseline_gate["schema"] or not baseline_gate["integrity"]:
        decision.update(reason="invalid_incumbent_reference", valid_comparison=False)
    elif not candidate_gate["schema"]:
        decision["reason"] = "candidate_schema_failed"
    elif not candidate_gate["integrity"]:
        decision.update(reason="candidate_integrity_failed", valid_comparison=False)
    elif not candidate_gate["semantic"]:
        decision["reason"] = "candidate_semantic_failed"
    elif recommendation == "retain" and (candidate != incumbent or changes):
        decision["reason"] = "retain_claim_contains_changes"
    elif recommendation == "retain":
        decision.update(action="retain", reason="incumbent_explicitly_retained")
    elif candidate.strip() == incumbent.strip():
        decision.update(action="retain", reason="identical_instructions_no_change")
    elif regressed:
        decision["reason"] = "previously_passing_case_regressed"
    elif len(improved) >= MIN_NEW_COMPLETE_CASES:
        decision.update(action="adopt", adopt=True, reason="more_complete_cases_without_regression")
    elif all(before.values()) and all(after.values()) and (
        (base_size["codepoints"] - candidate_size["codepoints"]) * 100
        >= MIN_CODEPOINT_REDUCTION_PERCENT * base_size["codepoints"]
    ):
        decision.update(action="adopt", adopt=True, reason="all_cases_pass_with_shorter_instructions")
    return decision


def main() -> int:
    try:
        baseline = json.loads(Path(os.environ["RSI_BASELINE_REPORT"]).read_text(encoding="utf-8"))
        result = decide(
            round_number=int(os.environ["RSI_ROUND"]),
            incumbent=os.environ["RSI_INCUMBENT_INSTRUCTIONS"],
            baseline=baseline,
            proposal=json.loads(os.environ["RSI_PROPOSAL_JSON"]),
            verification=json.loads(os.environ["RSI_VERIFICATION_JSON"]),
            judgement=json.loads(os.environ["RSI_JUDGEMENT_JSON"]),
            taskpack=os.environ.get("RSI_TASKPACK", ""),
        )
    except (DecisionInputError, ValueError, KeyError, OSError) as exc:
        result = {
            "schema_version": "rsi-decision-v1",
            "action": "reject",
            "adopt": False,
            "valid_comparison": False,
            "reason": "decision_input_invalid",
            "error": str(exc),
        }
        print(json.dumps({"decision": result}, ensure_ascii=False))
        return 2
    print(json.dumps({"decision": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
