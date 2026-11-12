import pytest


@pytest.fixture
def client():
    return object()


def test_uses(client):
    return client()


def helper():
    return 1


def run(helper):
    return helper()
