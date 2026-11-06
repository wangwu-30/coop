"""Boundary checks for the fixed adoption contract, independent of LLM output."""

import unittest

from decide import DecisionInputError, decide


def reports(passes, *, split="dev"):
    hard = {
        "suite_version": "rsi-review-suite-v1",
        "split": split,
        "schema_pass": True,
        "integrity_pass": True,
        "case_results": {
            f"D{i + 1:02}": {"pass": passed, "schema_pass": True}
            for i, passed in enumerate(passes)
        },
    }
    judgement = {
        "semantic_pass": True,
        "case_results": {
            case_id: {
                "pass": True,
                "problems": [],
                "observations_supported": True,
                "decisive_evidence_explained": True,
                "recommendations_proportionate": True,
            }
            for case_id in hard["case_results"]
        },
    }
    return {"verification": hard, "judgement": judgement}


class AdoptionContractTests(unittest.TestCase):
    def call(self, before, after, *, incumbent="甲" * 100, candidate="乙" * 100,
             recommendation="change", changes=None):
        return decide(
            round_number=1,
            incumbent=incumbent,
            baseline=before,
            proposal={
                "recommendation": recommendation,
                "hypothesis": "A bounded candidate for checking the adoption contract.",
                "candidate_instructions": candidate,
                "changes": changes if changes is not None else ["Candidate change"],
            },
            verification=after["verification"],
            judgement=after["judgement"],
            taskpack="rsi/eval/dev/tasks.json",
        )

    def test_one_repaired_case_without_regression_is_adopted(self):
        result = self.call(reports([False, True]), reports([True, True]))
        self.assertEqual(result["action"], "adopt")
        self.assertEqual(result["improved_cases"], ["D01"])

    def test_net_gain_cannot_hide_a_regression(self):
        result = self.call(reports([True, False, False]), reports([False, True, True]))
        self.assertFalse(result["adopt"])
        self.assertEqual(result["regressed_cases"], ["D01"])

    def test_fifteen_percent_unicode_boundary(self):
        before = reports([True, True])
        exact = self.call(before, reports([True, True]), candidate="乙" * 85)
        below = self.call(before, reports([True, True]), candidate="乙" * 86)
        self.assertTrue(exact["adopt"])
        self.assertEqual(exact["candidate"]["codepoints"], 85)
        self.assertFalse(below["adopt"])

    def test_padding_does_not_count_as_context_saving(self):
        result = self.call(reports([True]), reports([True]),
                           incumbent="  甲甲甲  ", candidate="甲甲甲")
        self.assertEqual(result["action"], "retain")
        self.assertEqual(result["codepoint_reduction_fraction"], 0)

    def test_shorter_candidate_with_schema_failure_is_rejected(self):
        after = reports([False, True])
        after["verification"]["schema_pass"] = False
        after["verification"]["case_results"]["D01"]["schema_pass"] = False
        result = self.call(reports([True, True]), after, candidate="乙")
        self.assertEqual(result["reason"], "candidate_schema_failed")

    def test_integrity_failure_blocks_adoption(self):
        after = reports([True, True])
        after["verification"]["integrity_pass"] = False
        result = self.call(reports([False, True]), after)
        self.assertFalse(result["adopt"])
        self.assertFalse(result["valid_comparison"])

    def test_semantic_failure_blocks_a_hard_pass(self):
        after = reports([True, True])
        after["judgement"]["semantic_pass"] = False
        case = after["judgement"]["case_results"]["D01"]
        case["pass"] = False
        case["observations_supported"] = False
        case["problems"] = ["A claim is unsupported by its cited evidence."]
        result = self.call(reports([False, True]), after, candidate="乙")
        self.assertEqual(result["reason"], "candidate_semantic_failed")

    def test_retain_never_becomes_a_fake_change(self):
        before = reports([True, True])
        unchanged = self.call(before, reports([True, True]), candidate="甲" * 100,
                              recommendation="retain", changes=[])
        altered = self.call(before, reports([True, True]), candidate="乙",
                            recommendation="retain", changes=[])
        self.assertEqual(unchanged["action"], "retain")
        self.assertFalse(unchanged["adopt"])
        self.assertEqual(altered["reason"], "retain_claim_contains_changes")

    def test_identical_text_does_not_get_credit_for_stochastic_gain(self):
        result = self.call(reports([False, True]), reports([True, True]),
                           candidate="甲" * 100)
        self.assertEqual(result["action"], "retain")

    def test_case_set_drift_is_not_comparable(self):
        with self.assertRaises(DecisionInputError):
            self.call(reports([True, True]), reports([True]))

    def test_contradictory_judge_summary_fails_closed(self):
        after = reports([True])
        after["judgement"]["semantic_pass"] = False
        with self.assertRaises(DecisionInputError):
            self.call(reports([True]), after)

    def test_holdout_is_not_used_for_candidate_selection(self):
        result = self.call(reports([True], split="holdout"),
                           reports([True], split="holdout"), candidate="乙")
        self.assertFalse(result["adopt"])
        self.assertEqual(result["reason"], "selection_requires_development_split")


if __name__ == "__main__":
    unittest.main()
