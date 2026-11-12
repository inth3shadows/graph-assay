from pkg import m
from pkg.m import Child


def make():
    a = m.Child()
    b = Child()
    return a, b
