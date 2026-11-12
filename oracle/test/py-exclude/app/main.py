from vendor.lib.util import vendored


def own():
    return 2


def run():
    return vendored() + own()
