"""Export class tags to HTML files for testing purposes."""

from pathlib import Path

from bs4.element import Tag


def export_class_tag(tag: Tag, name: str) -> None:
    """Export a class tag to a HTML file in html_examples.

    Class tags should generally be created using the get_classes_tags
    function.

    Args:
        tag (Tag): The tag to export.
        name (str): The name of the HTML file to export to.

    Examples:
        >>> from regybox.classes import get_classes_tags
        >>> from tests.html_examples.export import export_class_tag
        >>> tags = get_classes_tags(year=2024, month=7, day=1)
        >>> export_class_tag(tags[0], "example_class")
    """
    Path(__file__).parent.joinpath(f"{name}.html").write_text(tag.prettify(), encoding="utf-8")
