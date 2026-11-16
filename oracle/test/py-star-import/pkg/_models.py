__all__ = ["Request", "Response", "Headers", "build"]


class Request:
    def __init__(self, url):
        self.url = url


class Response:
    def __init__(self, status):
        self.status = status


class Headers:
    def __init__(self, items=None):
        self.items = items or {}


def build(status):
    return Response(status)
