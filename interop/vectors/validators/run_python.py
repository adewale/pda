# Runs the two Python validators over the corpus, inside the container
# run.mjs starts with no network. Mounted read-only: /src/poppy-validator and
# /src/poppy-sidecar (each project at its pinned commit), /corpus. Writable:
# /out. Neither project is installed; each is imported from its source tree.
import json
import sys

manifest = json.load(open("/corpus/manifest.json"))


def text_of(entry):
    return open(f"/corpus/docs/{entry['file']}", encoding="utf-8", errors="replace").read()


def run(name, check):
    results = {}
    for entry in manifest:
        try:
            results[entry["file"]] = check(entry)
        except Exception as err:  # record, don't stop
            results[entry["file"]] = {"valid": None, "findings": [f"crash:{type(err).__name__}: {err}"]}
    json.dump(results, open(f"/out/{name}.json", "w"), indent=2)
    print(f"{name}: {len(results)} reports")


# tusharck/poppy-validator: validate_text, file mode (no OAuth cross-check, no fetch).
sys.path.insert(0, "/src/poppy-validator/src")
from poppy_validator.validator import validate_text  # noqa: E402


def poppy_validator(entry):
    report = validate_text(text_of(entry), domain=entry["domain"])
    return {"valid": report.errors == 0, "findings": [f"{f.severity.value}:{f.rule.id}" for f in report.findings]}


run("poppy-validator", poppy_validator)

# habib-analyst/poppy-sidecar: validate on parsed JSON, live checks off.
sys.path.insert(0, "/src/poppy-sidecar")
from poppy_sidecar.validator import validate  # noqa: E402


def poppy_sidecar(entry):
    try:
        doc = json.loads(text_of(entry))
    except ValueError as err:
        return {"valid": False, "findings": [f"error:JSON_PARSE ({err.__class__.__name__})"]}
    report = validate(doc, domain=entry["domain"], live=False)
    return {"valid": report.ok, "findings": [f"{f.level}:{f.code}" for f in report.findings]}


run("poppy-sidecar", poppy_sidecar)
