import io
import threading
from contextlib import contextmanager


@contextmanager
def isolation():
    yield io.BytesIO(), io.BytesIO()


def with_tuple():
    with isolation() as (out, err):
        return err.getvalue()


def loop_threads():
    threads = [threading.Thread(target=print) for _ in range(3)]
    for t in threads:
        t.start()


def direct():
    buf = io.BytesIO()
    buf.getvalue()
    t = threading.Thread(target=print)
    t.start()
