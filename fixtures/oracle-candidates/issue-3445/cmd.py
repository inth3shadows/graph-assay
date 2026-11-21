class Command:
    def invoke(self, ctx):
        return ctx


class CliRunner:
    def invoke(self, cli):
        return cli


def command(f) -> Command:
    return Command()


@command
def cli():
    pass


def run():
    cli.invoke(None)
