def deco(f):
    return f


def deco_factory(n):
    return deco


class Base:
    def run(self):
        return 1


class Child(Base):
    def run(self):
        return super().run() + 1


class Holder:
    def __init__(self, fn):
        self.fn = fn

    def call(self):
        return self.fn()


@deco
@deco_factory(2)
def plain():
    return Base().run()


def chained(h):
    return (
        Holder(plain)
        .call()
    )
