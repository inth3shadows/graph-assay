class Config:
    def read_config(self):
        return 1

    class Nested:
        def read_config(self):
            return 2


def read_config():
    def inner():
        return 3
    return inner()
