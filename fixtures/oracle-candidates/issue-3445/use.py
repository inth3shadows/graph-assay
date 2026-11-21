from models import Parameter, get_params


def loop_annotated(items: list[Parameter]):
    for widget in items:
        widget.describe()


def loop_returned():
    for widget in get_params():
        widget.describe()


def comprehension():
    return [widget.describe() for widget in get_params()]


def other_name(items: list[Parameter]):
    for p in items:
        p.describe()
