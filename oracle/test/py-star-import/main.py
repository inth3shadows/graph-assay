import pkg
from pkg._models import Response as Reply
from pkg._models import Request


def through_package():
    r = pkg.Response(200)
    h = pkg.Headers()
    t = pkg.MockTransport(lambda q: r)
    return pkg.build(204), h, t


def direct():
    return Reply(200), Request("/")


class Sub(pkg.MockTransport):
    def __init__(self):
        super().__init__(lambda q: None)


def chained():
    from pkg._chain import Chain1
    from pkg._chain2 import Chain2
    return Chain1(), Chain2()


def exists(p):
    return p


def stdlib_named():
    import os
    return os.path.exists("x"), exists("y")
