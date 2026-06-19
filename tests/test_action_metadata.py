"""Tests for the composite GitHub Action metadata."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_email_sender_preserves_display_name_with_valid_address() -> None:
    action_text = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "from: ${{ inputs.email-from-name }} <${{ inputs.email-username }}>" in action_text


def test_action_defaults_not_open_enrollment_to_noop() -> None:
    action_lines = (REPO_ROOT / "action.yml").read_text(encoding="utf-8").splitlines()
    input_start = action_lines.index("  not-open-is-noop:")
    next_input = next(
        index
        for index, line in enumerate(action_lines[input_start + 1 :], start=input_start + 1)
        if line.startswith("  ") and not line.startswith("    ")
    )

    assert '    default: "true"' in action_lines[input_start:next_input]


def test_class_operation_workflow_exposes_dispatch_and_kv_inputs() -> None:
    workflow_text = (REPO_ROOT / ".github/workflows/class_operation.yml").read_text(
        encoding="utf-8"
    )

    assert "workflow_dispatch:" in workflow_text
    assert "operation:" in workflow_text
    assert "class-date:" in workflow_text
    assert "class-time:" in workflow_text
    assert "class-type:" in workflow_text
    assert "calendar-event-name:" in workflow_text
    assert "cache-key:" in workflow_text
    assert "calendar-fingerprint:" in workflow_text
    assert "calendar-event-name: ${{ inputs.calendar-event-name }}" in workflow_text
    assert "timeout-seconds: 900" in workflow_text
    assert "not-open-is-noop: true" in workflow_text
    assert "cf-account-id: ${{ secrets.CF_ACCOUNT_ID }}" in workflow_text
    assert "cf-kv-namespace-id: ${{ secrets.CF_KV_NAMESPACE_ID }}" in workflow_text
    assert "cf-kv-api-token: ${{ secrets.CF_KV_API_TOKEN }}" in workflow_text


def test_fixed_github_schedule_workflows_keep_manual_dispatch() -> None:
    for workflow in ("scheduled_runs.yml", "scheduled_holiday_runs.yml"):
        workflow_text = (REPO_ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8")

        assert "workflow_dispatch:" in workflow_text


def test_make_test_runs_cloudflare_worker_tests() -> None:
    makefile_text = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")

    assert "test-worker" in makefile_text
    assert "cloudflare/regybox-scheduler" in makefile_text
    assert "npm test" in makefile_text
