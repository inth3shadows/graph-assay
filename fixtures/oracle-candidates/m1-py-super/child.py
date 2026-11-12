from base import Base


class Child(Base):
    def __init__(self):
        super().__init__("child")

    def greet(self):
        return super().greet() + "!"


class Local:
    def run(self):
        return 1


class LocalChild(Local):
    def run(self):
        return super().run() + 1
