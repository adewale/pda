# Python for the two third-party validators (run.mjs). Only poppy-validator's
# one dependency is installed, at the versions in its uv.lock at the pinned
# commit; poppy-sidecar has none. Their source is mounted read-only at run
# time, never installed, and the container runs with no network.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
RUN python -m pip install --no-cache-dir \
      "jsonschema==4.26.0" "jsonschema-specifications==2025.9.1" "referencing==0.37.0" \
      "rpds-py==2026.9.1" "attrs==26.1.0" "typing-extensions==4.16.0"
COPY run_python.py /run_python.py
USER nobody
ENTRYPOINT ["python", "-I", "/run_python.py"]
