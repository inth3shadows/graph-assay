import pkg
from pkg import command, Prompt


@pkg.command()
def cli():
    pass


def run():
    command("x")
    Prompt.ask("y")
