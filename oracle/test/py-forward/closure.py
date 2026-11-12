def make():
    return lambda v: v


def outer():
    evaluate = make()

    def inner():
        return evaluate(1)

    return inner


def comp(polys):
    return [p(0) for p in polys]
