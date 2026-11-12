from pkg.util import helper, deco, Box

TOP = helper(1)


def outer():
    def inner():
        return helper(2)

    return inner() + helper(3)


@deco
def decorated():
    b = Box(4)
    return b.get()


def dynamic(o):
    return o.get()


def twice():
    helper(5)
    helper(6)
