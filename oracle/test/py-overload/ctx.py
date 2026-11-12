import typing as t


@t.overload
def current(silent: t.Literal[False] = False) -> int: ...


@t.overload
def current(silent: bool = ...) -> int | None: ...


def current(silent: bool = False) -> int | None:
    return None if silent else 1


def plain() -> int:
    return 2


class Box:
    def __init__(self, n: int) -> None:
        self.n = n
