#!/usr/bin/env python3
"""Privacy and aggregation checks for the Chrome debugger-banner diagnosis."""

from __future__ import annotations

import unittest

from agent import researchtube_agent as agent


class DebugBannerTests(unittest.TestCase):
    def test_all_instances_with_switch_suppress_the_banner(self) -> None:
        result = agent.summarize_debug_banner_process_report({
            "chromeRunning": True, "browserInstances": 2, "enabledInstances": 2,
        })
        self.assertEqual(result["configuration"], "banner_suppressed")
        self.assertEqual(result["requiredSwitch"], "--silent-debugger-extension-api")
        self.assertNotIn("pid", result)
        self.assertNotIn("commandLine", result)

    def test_no_instances_with_switch_enable_the_banner(self) -> None:
        result = agent.summarize_debug_banner_process_report({
            "chromeRunning": True, "browserInstances": 2, "enabledInstances": 0,
        })
        self.assertEqual(result["configuration"], "banner_enabled")
        self.assertIn("without --silent-debugger-extension-api", result["message"])

    def test_mixed_instances_report_that_banner_may_appear(self) -> None:
        result = agent.summarize_debug_banner_process_report({
            "chromeRunning": True, "browserInstances": 2, "enabledInstances": 1,
        })
        self.assertEqual(result["configuration"], "mixed")
        self.assertIn("may appear", result["message"])

    def test_no_chrome_and_invalid_report_are_unknown(self) -> None:
        no_chrome = agent.summarize_debug_banner_process_report({
            "chromeRunning": False, "browserInstances": 0, "enabledInstances": 0,
        })
        self.assertEqual(no_chrome["configuration"], "unknown")
        self.assertFalse(no_chrome["chromeRunning"])
        invalid = agent.summarize_debug_banner_process_report({"chromeRunning": True, "browserInstances": 1, "enabledInstances": 2})
        self.assertEqual(invalid["configuration"], "unknown")
        self.assertIsNone(invalid["chromeRunning"])


if __name__ == "__main__":
    unittest.main()
