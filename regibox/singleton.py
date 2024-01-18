from __future__ import annotations

from typing import ClassVar


class Singleton(type):
    _instances: ClassVar[dict[Singleton, Singleton]] = {}

    def __call__(cls, *args: object, **kwargs: object) -> Singleton:
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]
