def fail():
    raise ReferenceError("x")


class ReferenceError(ValueError):
    pass


def fail_later():
    raise ReferenceError("y")
