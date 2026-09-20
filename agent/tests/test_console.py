"""Startup console behaviour checks."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from agent import researchtube_agent as agent


class ConsoleTests(unittest.TestCase):
    @patch("agent.researchtube_agent.os.system")
    @patch("agent.researchtube_agent.sys.stdout.isatty", return_value=True)
    def test_clear_console_uses_platform_command_for_interactive_terminal(self, _isatty, system) -> None:
        agent.clear_console()
        system.assert_called_once_with("cls" if agent.os.name == "nt" else "clear")

    @patch("agent.researchtube_agent.os.system")
    @patch("agent.researchtube_agent.sys.stdout.isatty", return_value=False)
    def test_clear_console_skips_non_interactive_output(self, _isatty, system) -> None:
        agent.clear_console()
        system.assert_not_called()


if __name__ == "__main__":
    unittest.main()
