class A:
    @staticmethod
    def run(): return 1
class B:
    def run(self): return 3


def use():
    return A.run()
