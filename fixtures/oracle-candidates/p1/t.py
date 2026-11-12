import re


def flat(html):
    return html.strip()


def test_one(plain):
    flat = lambda h: re.sub(r"\s+", " ", h)
    return flat(plain)
