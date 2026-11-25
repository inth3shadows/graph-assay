import helpers
from helpers import check


def test_attr():
    assert helpers.check(1) == 1


def test_name():
    assert check(1) == 1
