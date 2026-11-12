import pkg
from pkg import AsyncClient


async def attr_named_client():
    client = pkg.AsyncClient()
    await client.fetch("u")


async def attr_named_c():
    c = pkg.AsyncClient()
    await c.fetch("u")


async def from_named_client():
    client = AsyncClient()
    await client.fetch("u")


async def with_named_client():
    async with pkg.AsyncClient() as client:
        await client.fetch("u")
