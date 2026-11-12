import pkg
from pkg.models import Other, Req


def top():
    return pkg.Req().prepare()


def chained(r: Req):
    return r.name("a").name("b")


def neighbours(r: Req, rs: list[Req]):
    r.prepare()
    rs[0].prepare()


def first(rs: list[Req]):
    return rs[0].prepare(pkg.Req())


def reversed_neighbours(r: Req, rs: list[Req]):
    rs[0].prepare()
    r.prepare()
