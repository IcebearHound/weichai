from __future__ import annotations

import unittest

import context
from resilient_pricing.account_order_sorter import AccountOrderSorter
from resilient_pricing.async_log_reservoir import AsyncLogReservoir
from resilient_pricing.batch_name_resolver import BatchNameResolver
from resilient_pricing.duplicate_stamp_book import DuplicateStampBook
from resilient_pricing.fetch_route_table import FetchRouteTable


class AccountOrderingCasebook(unittest.TestCase):
    def test_sort_keeps_account_sequences_contiguous(self) -> None:
        source = [
            {"account": "beta", "id": "b-2", "sequence": 2, "payload": "B2"},
            {"account": "alpha", "id": "a-7", "sequence": 7, "payload": "A7"},
            {"account": "beta", "id": "b-1", "sequence": 1, "payload": "B1"},
            {"account": "alpha", "id": "a-3", "sequence": 3, "payload": "A3"},
        ]
        result = AccountOrderSorter().sort(source)
        self.assertEqual([row["id"] for row in result], ["a-3", "a-7", "b-1", "b-2"])
        self.assertEqual([row["payload"] for row in result], ["A3", "A7", "B1", "B2"])
        self.assertEqual(source[0]["id"], "b-2")

    def test_missing_sequence_can_sort_after_numbered_messages(self) -> None:
        source = [
            {"account": "alpha", "id": "unknown", "sequence": None},
            {"account": "alpha", "id": "known", "sequence": 9},
        ]
        result = AccountOrderSorter(missing_sequence_last=True).sort(source)
        self.assertEqual([row["id"] for row in result], ["known", "unknown"])

    def test_missing_sequence_can_sort_before_numbered_messages(self) -> None:
        source = [
            {"account": "alpha", "id": "known", "sequence": 0},
            {"account": "alpha", "id": "unknown", "sequence": None},
        ]
        result = AccountOrderSorter(missing_sequence_last=False).sort(source)
        self.assertEqual([row["id"] for row in result], ["unknown", "known"])

    def test_equal_sequences_use_identifier_as_deterministic_tiebreaker(self) -> None:
        source = [
            {"account": "x", "id": "msg-c", "sequence": 4},
            {"account": "x", "id": "msg-a", "sequence": 4},
            {"account": "x", "id": "msg-b", "sequence": 4},
        ]
        result = AccountOrderSorter().sort(source)
        self.assertEqual([row["id"] for row in result], ["msg-a", "msg-b", "msg-c"])

    def test_gap_report_finds_missing_and_duplicate_sequences(self) -> None:
        rows = (
            {"account": "a", "id": "a-1", "sequence": 1},
            {"account": "a", "id": "a-4", "sequence": 4},
            {"account": "a", "id": "a-4b", "sequence": 4},
            {"account": "b", "id": "b-8", "sequence": 8},
        )
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["gaps"]["a"], (2, 3))
        self.assertEqual(report["duplicate_sequences"]["a"], (4,))
        self.assertEqual(report["high_water"], {"a": 4, "b": 8})
        self.assertEqual(report["gap_count"], 2)
        self.assertEqual(report["duplicate_count"], 1)

    def test_gap_report_detects_out_of_order_arrival(self) -> None:
        rows = (
            {"account": "a", "id": "third", "sequence": 3},
            {"account": "a", "id": "first", "sequence": 1},
            {"account": "b", "id": "one", "sequence": 1},
            {"account": "b", "id": "two", "sequence": 2},
        )
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["out_of_order_accounts"], ("a",))
        self.assertEqual(report["gaps"]["a"], (2,))
        self.assertEqual(report["gaps"]["b"], ())

    def test_gap_report_separates_missing_sequence_from_malformed_rows(self) -> None:
        rows = (
            {"account": "a", "id": "pending", "sequence": None},
            {"account": "", "id": "bad", "sequence": 1},
            {"account": "a", "id": "negative", "sequence": -1},
            {"account": "a", "id": "boolean", "sequence": True},
        )
        report = AccountOrderSorter().ordering_gap_report(rows)
        self.assertEqual(report["missing_sequences"], ("pending",))
        self.assertEqual(report["malformed_indexes"], (1, 2, 3))
        self.assertEqual(report["rows"], 0)

    def test_sort_rejects_invalid_identifiers_and_sequence_types(self) -> None:
        sorter = AccountOrderSorter()
        invalid_rows = (
            [{"account": "", "id": "m", "sequence": 1}],
            [{"account": "a", "id": "", "sequence": 1}],
            [{"account": "a", "id": "m", "sequence": "1"}],
            [{"account": "a", "id": "m", "sequence": -1}],
        )
        for rows in invalid_rows:
            with self.subTest(rows=rows):
                with self.assertRaises((TypeError, ValueError)):
                    sorter.sort(rows)


class RouteTopologyCasebook(unittest.TestCase):
    def test_breadth_first_path_prefers_fewer_hops(self) -> None:
        table = FetchRouteTable(
            {
                "LON": {"FRA", "NYC"},
                "FRA": {"SIN"},
                "SIN": {"SHA"},
                "NYC": {"SHA"},
            }
        )
        self.assertEqual(table.path("lon", "sha"), ("LON", "NYC", "SHA"))

    def test_equal_length_routes_use_lexical_neighbor_order(self) -> None:
        table = FetchRouteTable(
            {
                "A": {"C", "B"},
                "B": {"D"},
                "C": {"D"},
            }
        )
        self.assertEqual(table.path("A", "D"), ("A", "B", "D"))

    def test_unreachable_destination_returns_empty_tuple(self) -> None:
        table = FetchRouteTable({"A": {"B"}, "X": {"Y"}})
        self.assertEqual(table.path("A", "Y"), ())
        self.assertEqual(table.path("Y", "A"), ())

    def test_identity_path_needs_no_registered_vertex(self) -> None:
        table = FetchRouteTable()
        self.assertEqual(table.path("remote", "REMOTE"), ("REMOTE",))

    def test_topology_report_counts_components_roots_and_leaves(self) -> None:
        table = FetchRouteTable(
            {
                "A": {"B", "C"},
                "B": {"D"},
                "C": {"D"},
                "X": {"Y"},
            }
        )
        report = table.route_topology_report()
        self.assertEqual(report["vertices"], 6)
        self.assertEqual(report["edges"], 5)
        self.assertEqual(report["roots"], ("A", "X"))
        self.assertEqual(report["leaves"], ("D", "Y"))
        self.assertEqual(report["component_count"], 2)
        self.assertFalse(report["cyclic"])

    def test_topology_report_detects_long_cycle(self) -> None:
        table = FetchRouteTable({"A": {"B"}, "B": {"C"}, "C": {"A", "D"}})
        report = table.route_topology_report()
        self.assertTrue(report["cyclic"])
        self.assertEqual(report["roots"], ())
        self.assertEqual(report["leaves"], ("D",))
        self.assertEqual(report["component_count"], 1)

    def test_density_uses_directed_graph_capacity(self) -> None:
        table = FetchRouteTable({"A": {"B", "C"}, "B": {"A"}, "C": {"A"}})
        report = table.route_topology_report()
        self.assertAlmostEqual(report["density"], 4 / 6)
        self.assertEqual(report["indegree"], {"A": 2, "B": 1, "C": 1})

    def test_constructor_normalizes_and_deduplicates_neighbors(self) -> None:
        table = FetchRouteTable({" hub ": {"east", " EAST ", "west"}})
        report = table.route_topology_report()
        self.assertEqual(report["edges"], 2)
        self.assertEqual(report["roots"], ("HUB",))
        self.assertEqual(table.path("hub", "east"), ("HUB", "EAST"))

    def test_isolated_vertex_is_both_root_and_leaf(self) -> None:
        table = FetchRouteTable({"SOLO": set(), "A": {"B"}})
        report = table.route_topology_report()
        self.assertEqual(report["vertices"], 3)
        self.assertEqual(report["roots"], ("A", "SOLO"))
        self.assertEqual(report["leaves"], ("B", "SOLO"))
        self.assertEqual(report["component_count"], 2)
        self.assertEqual(table.path("SOLO", "B"), ())

    def test_self_route_and_empty_endpoint_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "self route"):
            FetchRouteTable({"A": {"a"}})
        table = FetchRouteTable()
        with self.assertRaisesRegex(ValueError, "endpoints"):
            table.path(" ", "A")


class BufferPressureCasebook(unittest.TestCase):
    def test_pressure_report_partitions_rows_by_chunk_size(self) -> None:
        reservoir = AsyncLogReservoir(chunk_size=3)
        report = reservoir.flush_pressure_report((10, 20, 30, 40, 50, 60, 70))
        self.assertEqual(report["batch_count"], 3)
        self.assertEqual(report["batches"][0], {
            "first_row": 0,
            "last_row": 2,
            "rows": 3,
            "bytes": 60,
            "largest_row": 30,
        })
        self.assertEqual(report["batches"][-1]["rows"], 1)
        self.assertEqual(report["peak"], 150)
        self.assertAlmostEqual(report["utilization"], 7 / 9)

    def test_pressure_statistics_use_population_standard_deviation(self) -> None:
        report = AsyncLogReservoir(chunk_size=4).flush_pressure_report((2, 4, 4, 4, 5, 5, 7, 9))
        self.assertEqual(report["total"], 40)
        self.assertEqual(report["average_row"], 5.0)
        self.assertEqual(report["row_standard_deviation"], 2.0)

    def test_exact_chunk_boundary_has_full_utilization(self) -> None:
        report = AsyncLogReservoir(chunk_size=2).flush_pressure_report((5, 7, 11, 13))
        self.assertEqual(report["batch_count"], 2)
        self.assertEqual(report["utilization"], 1.0)
        self.assertEqual(report["batches"][0]["bytes"], 12)
        self.assertEqual(report["batches"][1]["bytes"], 24)
        self.assertEqual(report["peak"], 24)

    def test_empty_pressure_report_has_no_batches(self) -> None:
        report = AsyncLogReservoir(chunk_size=8).flush_pressure_report(())
        self.assertEqual(report["batches"], ())
        self.assertEqual(report["peak"], 0)
        self.assertEqual(report["utilization"], 0.0)
        self.assertEqual(report["persisted_rows"], 0)

    def test_pressure_report_rejects_boolean_and_negative_sizes(self) -> None:
        reservoir = AsyncLogReservoir()
        with self.assertRaises(TypeError):
            reservoir.flush_pressure_report((True,))
        with self.assertRaises(ValueError):
            reservoir.flush_pressure_report((4, -1))

    def test_dedupe_report_tracks_prefixes_and_lru_endpoints(self) -> None:
        book = DuplicateStampBook(capacity=4)
        for message_id in ("a:1", "b:1", "a:2", "a:1", "c:1"):
            book.seen(message_id)
        report = book.dedupe_pressure_report()
        self.assertEqual(report["oldest"], "b:1")
        self.assertEqual(report["newest"], "c:1")
        self.assertEqual(report["prefixes"], {"a": 2, "b": 1, "c": 1})
        self.assertEqual(report["duplicates"], 1)
        self.assertEqual(report["repeated"][0]["message_id"], "a:1")

    def test_alias_cycle_is_reported_when_name_is_resolved(self) -> None:
        resolver = BatchNameResolver({"a": "b", "b": "c", "c": "a"})
        with self.assertRaisesRegex(ValueError, "alias cycle detected"):
            resolver.resolve("a")
        report = resolver.name_grammar_report(("a", "independent"))
        self.assertEqual(len(report["rejected"]), 1)
        self.assertEqual(report["accepted"][0]["resolved"], "independent")


if __name__ == "__main__":
    unittest.main()
