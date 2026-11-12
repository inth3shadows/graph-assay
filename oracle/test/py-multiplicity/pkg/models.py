class Req:
    def prepare(self, other=None):
        return self

    def name(self, x):
        return self


class Other:
    def prepare(self):
        return self
