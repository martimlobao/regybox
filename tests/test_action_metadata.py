"""Tests for the composite GitHub Action metadata."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_email_sender_preserves_display_name_with_valid_address() -> None:
    action_text = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "from: ${{ inputs.email-from-name }} <${{ inputs.email-username }}>" in action_text


def test_calendar_sync_workflow_exposes_dispatch_and_kv_inputs() -> None:
    workflow_text = (REPO_ROOT / ".github/workflows/calendar_sync.yml").read_text(encoding="utf-8")

    assert "workflow_dispatch:" in workflow_text
    assert "uv run regybox-sync" in workflow_text
    assert "calendar-event-names:" in workflow_text
    assert "target-class-types:" in workflow_text
    assert "CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}" in workflow_text
    assert "CF_KV_NAMESPACE_ID: ${{ secrets.CF_KV_NAMESPACE_ID }}" in workflow_text
    assert "CF_KV_API_TOKEN: ${{ secrets.CF_KV_API_TOKEN }}" in workflow_text
