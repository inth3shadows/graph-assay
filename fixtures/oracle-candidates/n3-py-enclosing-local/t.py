def closure(make):
    evaluate = make()

    def inner(path):
        return evaluate(path)

    return inner
