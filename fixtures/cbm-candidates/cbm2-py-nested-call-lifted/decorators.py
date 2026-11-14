def echo(message):
    print(message)


def version_option(version):
    def callback(ctx):
        echo(version)

    return callback
