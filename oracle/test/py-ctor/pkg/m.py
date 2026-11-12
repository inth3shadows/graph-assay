class Base:
    def __init__(self, helper=None):
        self.ready = True
        self.helper = helper


class Child(Base):
    def __init__(self):
        super().__init__()


class Helper:
    def __init__(self):
        self.ok = True


class Kid(Base):
    def __init__(self):
        super().__init__(Helper())
