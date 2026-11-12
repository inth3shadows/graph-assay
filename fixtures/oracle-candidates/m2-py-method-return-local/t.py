class Stager:
    def add(self, rows):
        return rows


class Store:
    def stage(self) -> Stager:
        return Stager()


def make() -> Stager:
    return Stager()


def via_function():
    s = make()
    s.add([1])


def via_method():
    store = Store()
    s = store.stage()
    s.add([2])


def via_param_method(store: Store):
    s = store.stage()
    s.add([3])
