"""Module for implementing the Singleton design pattern."""

from __future__ import annotations

from typing import ClassVar, TypeVar, cast

T = TypeVar("T", bound=object)


class Singleton(type):
    """Metaclass for implementing the Singleton design pattern.

    This metaclass allows a class to have only one instance throughout the
    program. It maintains a dictionary of instances for each class and ensures
    that only one instance is created.

    Note:
        The Singleton metaclass is used to create singleton classes that have
        only one instance. It overrides the __call__ method to check if an
        instance of the class already exists and returns it if available,
        otherwise it creates a new instance and stores it in the dictionary of
        instances.
    """

    _instances: ClassVar[dict[type[object], object]] = {}

    def __call__(cls: type[T], *args: object, **kwargs: object) -> T:
        """Method for creating or retrieving the instance of the class.

        Returns:
            The instance of the class.
        """
        if cls not in Singleton._instances:
            Singleton._instances[cls] = type.__call__(cls, *args, **kwargs)
        return cast("T", Singleton._instances[cls])
