def test_invoke(runner):
    def cli():
        return 0

    result = runner.invoke(cli, [])
    return result
