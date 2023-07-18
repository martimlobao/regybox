import importlib
import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from regibox import __package__ as main_package
from regibox import __version__

if TYPE_CHECKING:
    import io


def test_version() -> None:
    file_: io.BufferedReader
    with Path("pyproject.toml").open("rb") as file_:
        project_meta: dict[str, Any] = tomllib.load(file_)

    assert __version__ == project_meta["tool"]["poetry"]["version"]
    # run `poetry install` if this is failing locally
    assert __version__ == importlib.metadata.version(main_package)
