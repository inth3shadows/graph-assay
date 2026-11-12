class Layer:
    def __call__(self, x):
        return x


class MLP:
    def __init__(self):
        self.out = Layer()

    def forward(self, x):
        return self.out(x)
