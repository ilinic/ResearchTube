#!/usr/bin/env python3
"""Privacy and aggregation checks for the Chrome debugger-banner diagnosis."""

from __future__ import annotations

import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch

from agent import researchtube_agent as agent
from agent.chrome_processes import chrome_process_report


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

    def test_native_report_ignores_renderers_and_never_exposes_arguments(self):
        class Gone(Exception):
            pass
        class Denied(Exception):
            pass
        def process(name, arguments):
            def cmdline():
                if isinstance(arguments, Exception):
                    raise arguments
                return arguments
            return SimpleNamespace(info={'name': name}, cmdline=cmdline)
        processes = [process('chrome.exe', ['chrome.exe', '--silent-debugger-extension-api', '--profile-directory=PRIVATE']),
                     process('chrome.exe', ['chrome.exe', '--type=renderer']),
                     process('other.exe', []), process('chrome.exe', Gone())]
        psutil = SimpleNamespace(process_iter=lambda _attrs: processes, NoSuchProcess=Gone, AccessDenied=Denied)
        with patch.dict(sys.modules, {'psutil': psutil}):
            report = chrome_process_report()
            self.assertEqual(report, {'chromeRunning': True, 'browserInstances': 1,
                                      'enabledInstances': 1, 'unreadableProcesses': 0})
            self.assertEqual(agent.summarize_debug_banner_process_report(report)['configuration'], 'banner_suppressed')
            for unavailable in [[], Denied(), OSError()]:
                processes.append(process('chrome.exe', unavailable))
                result = agent.summarize_debug_banner_process_report(chrome_process_report())
                self.assertEqual(result['configuration'], 'unknown')
                self.assertNotIn('PRIVATE', str(result))
                self.assertNotIn('commandLine', result)


class NativeProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_scan_works_without_powershell_in_source_and_frozen(self):
        with patch.object(agent.os, 'name', 'nt'), patch.object(agent, 'chrome_process_report', return_value={
                'chromeRunning': True, 'browserInstances': 1, 'enabledInstances': 1}) as scan, \
             patch.object(agent, 'health_process_output', side_effect=AssertionError('no PowerShell')):
            for frozen in [False, True]:
                with patch.object(sys, 'frozen', frozen, create=True):
                    self.assertEqual((await agent.chrome_automation_status())['state'], 'enabled')
            self.assertEqual(scan.call_count, 2)


if __name__ == "__main__":
    unittest.main()
