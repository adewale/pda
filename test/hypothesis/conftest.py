"""
Hypothesis settings and the mock Company for the suite.

Profiles (choose with `--hypothesis-profile`, or HYPOTHESIS_PROFILE):

- `default`: 100 runs of at most 30 steps; about a minute.
- `deep`: 2,000 runs of at most 60 steps, for long local runs.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from hypothesis import HealthCheck, settings

from mock_server import MockServer

_COMMON = dict(deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much])
settings.register_profile("default", max_examples=100, stateful_step_count=30, **_COMMON)
settings.register_profile("deep", max_examples=2000, stateful_step_count=60, **_COMMON)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "default"))


@pytest.fixture(scope="session")
def mock_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[MockServer]:
    server = MockServer(Path(tmp_path_factory.mktemp("mock")))
    try:
        yield server
    finally:
        server.close()


def pytest_terminal_summary(terminalreporter: pytest.TerminalReporter) -> None:
    from machine import COVERAGE

    if COVERAGE:
        terminalreporter.section("what the state machine reached (rule: expected outcome, count)")
        for outcome, count in sorted(COVERAGE.items()):
            terminalreporter.write_line(f"{count:7d}  {outcome}")
