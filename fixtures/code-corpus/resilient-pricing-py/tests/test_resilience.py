from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.expiring_quote_pool import ExpiringQuotePool


class ResilienceTests(unittest.TestCase):
    def test_pool_reuses_a_fresh_value(self) -> None:
        now = [10.0]
        calls = [0]
        pool = ExpiringQuotePool(5.0, lambda: now[0])

        def load() -> int:
            calls[0] += 1
            return 17

        self.assertEqual(pool.obtain("EUR/USD", load), 17)
        self.assertEqual(pool.obtain("EUR/USD", load), 17)
        self.assertEqual(calls[0], 1)

    def test_duplicate_book_is_bounded(self) -> None:
        book = DuplicateStampBook(2)
        self.assertFalse(book.seen("a"))
        self.assertTrue(book.seen("a"))
        self.assertFalse(book.seen("b"))
        self.assertFalse(book.seen("c"))
        self.assertFalse(book.seen("a"))

    def test_reservoir_chunks_rows(self) -> None:
        async def scenario() -> list[tuple[bytes, ...]]:
            chunks: list[tuple[bytes, ...]] = []
            async def writer(rows: tuple[bytes, ...]) -> None:
                chunks.append(tuple(rows))
            count = await AsyncLogReservoir(2).drain([b"a", b"b", b"c"], writer)
            self.assertEqual(count, 3)
            return chunks
        self.assertEqual(asyncio.run(scenario()), [(b"a", b"b"), (b"c",)])


if __name__ == "__main__":
    unittest.main()
