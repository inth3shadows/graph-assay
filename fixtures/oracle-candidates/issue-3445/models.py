class Widget:
    def describe(self):
        return "widget"


class Parameter:
    def describe(self):
        return "param"


def get_params() -> "list[Parameter]":
    return [Parameter()]
