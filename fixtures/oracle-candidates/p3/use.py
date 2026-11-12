from pathlib import Path


def make(p: Path) -> Path:
    return p


def size(p: Path) -> int:
    return p.stat().st_size


def size_of_made(q: Path) -> int:
    made = make(q)
    return made.stat().st_size
