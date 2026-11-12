def helper(x):
    return x


def deco(fn):
    return fn


class Box:
    def __init__(self, v):
        self.v = helper(v)

    def get(self):
        return helper(self.v)


def get():
    return 0
