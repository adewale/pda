"""
Builds and runs test/hypothesis/launcher.ts: our mock Company in Node on
127.0.0.1, with no Docker. One process serves the whole pytest session; each
Hypothesis example starts from `reset`.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
from pathlib import Path
from typing import Any

import httpx

REPO = Path(__file__).resolve().parents[2]
SUFFIX = "company.interop.test"
COMPANY_ID = "hyp"
DOMAIN = f"{COMPANY_ID}.{SUFFIX}"


class MockServer:
    def __init__(self, workdir: Path) -> None:
        bundle = workdir / "launcher.mjs"
        subprocess.run(
            ["node", str(REPO / "interop/impls/shared/build.mjs"), str(REPO / "test/hypothesis/launcher.ts"), str(bundle)],
            cwd=REPO,
            check=True,
        )
        self.secret = secrets.token_urlsafe(32)
        self._log = open(workdir / "launcher.log", "w")
        self._process = subprocess.Popen(
            ["node", str(bundle)],
            cwd=REPO,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._log,
            env={**os.environ, "HYPOTHESIS_MOCK_SECRET": self.secret},
            text=True,
        )
        assert self._process.stdout is not None
        line = self._process.stdout.readline()
        if not line:
            raise RuntimeError(f"the launcher exited; see {workdir / 'launcher.log'}")
        ports = json.loads(line)
        self.company_port: int = ports["company"]
        self.control = httpx.Client(
            base_url=f"http://127.0.0.1:{ports['control']}",
            headers={"Authorization": f"Bearer {self.secret}"},
            timeout=30,
        )

    def close(self) -> None:
        self.control.close()
        if self._process.stdin:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.kill()
        self._log.close()

    # ---- control ----

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        response = self.control.request(method, path, json=body)
        if response.status_code != 200:
            raise RuntimeError(f"{method} {path}: {response.status_code} {response.text}")
        return response.json()

    def reset(self, config: dict[str, Any]) -> None:
        self._call("POST", "/reset", {"config": config})

    def serve_client_documents(self, documents: dict[str, Any]) -> None:
        self._call("POST", "/client-documents", {"documents": documents})

    def violations(self) -> list[dict[str, str]]:
        return self._call("GET", "/violations")["violations"]

    def state(self) -> dict[str, Any]:
        return self._call("GET", "/state")

    def hook(self, name: str, **params: Any) -> Any:
        return self._call("POST", f"/hooks/{name}", params)
