"""Tests for the composite GitHub Action metadata."""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_email_sender_preserves_display_name_with_valid_address() -> None:
    action_text = (REPO_ROOT / "action.yml").read_text(encoding="utf-8")

    assert "from: ${{ inputs.email-from-name }} <${{ inputs.email-username }}>" in action_text
