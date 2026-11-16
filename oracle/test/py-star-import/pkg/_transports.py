__all__ = ["BaseTransport", "MockTransport"]


class BaseTransport:
    def handle(self, request):
        raise NotImplementedError


class MockTransport(BaseTransport):
    def __init__(self, handler):
        self.handler = handler

    def handle(self, request):
        return self.handler(request)
