def echo(message):
    print(message)


class Greeter:
    def greet(self, name):
        echo(name)
        return self.loud(name)

    def loud(self, name):
        return name.upper()


def version_option(version):
    def callback(ctx):
        echo(version)

    return callback


def main():
    Greeter().greet("x")
    version_option("1")(None)
