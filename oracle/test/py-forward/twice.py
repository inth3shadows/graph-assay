def run(x):
    return x


class Cfg:
    def run(self, x):
        return x


def go(cfg: Cfg):
    return run(cfg.run(1))
