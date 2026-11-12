import typing as t


@t.overload
def command(name: t.Callable) -> int: ...          # line 5


@t.overload
def command(name: str | None = None) -> str: ...   # line 9


def command(name=None):                            # line 12, the implementation
    return real_work(name)


def real_work(n):
    return n


class Prompt:
    @t.overload
    @classmethod
    def ask(cls, p: str) -> str: ...               # line 23

    @t.overload
    @classmethod
    def ask(cls, p: str, d: int) -> int: ...

    @classmethod
    def ask(cls, p, d=None):                       # line 30, the implementation
        return real_work(p)
