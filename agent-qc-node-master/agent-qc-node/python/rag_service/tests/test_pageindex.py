import sys
from pathlib import Path

import pytest


# 确保可以直接 import pageindex 模块
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import pageindex  # noqa: E402  pylint: disable=wrong-import-position


def test_pageindex_search_merges_and_limits_results(monkeypatch):
    calls = {"embed": 0, "passage": 0, "verify": 0}

    def fake_embed(query):
        calls["embed"] += 1
        assert query == "患者术后发热"
        return [0.1, 0.2]

    def fake_passage(*args, **kwargs):
        calls["passage"] += 1
        return [
            {"txt": "p1", "similarity": 0.65, "source": "passage"},
            {"txt": "p2", "similarity": 0.45, "source": "passage"},
        ]

    def fake_verify(*args, **kwargs):
        calls["verify"] += 1
        return [
            {"txt": "v1", "similarity": 0.9, "source": "verify"},
            {"txt": "v2", "similarity": 0.3, "source": "verify"},
        ]

    monkeypatch.setattr(pageindex, "generate_query_embedding", fake_embed)
    monkeypatch.setattr(pageindex, "_search_passages", fake_passage)
    monkeypatch.setattr(pageindex, "_search_verify", fake_verify)

    results = pageindex.pageindex_search(
        "患者术后发热", note_qc_code="QC001", doc_ids=[1], limit_count=3
    )

    assert [r["txt"] for r in results] == ["v1", "p1", "p2"]
    assert all(r["similarity"] >= results[-1]["similarity"] for r in results)
    assert calls == {"embed": 1, "passage": 1, "verify": 1}


def test_pageindex_search_returns_empty_on_error(monkeypatch):
    def boom(_query):
        raise RuntimeError("embedding failed")

    monkeypatch.setattr(pageindex, "generate_query_embedding", boom)
    monkeypatch.setattr(pageindex, "_search_passages", lambda *args, **kwargs: [])
    monkeypatch.setattr(pageindex, "_search_verify", lambda *args, **kwargs: [])

    assert pageindex.pageindex_search("text", note_qc_code="QC001") == []


class DummyCursor:
    def __init__(self, rows):
        self.rows = rows
        self.executed_sql = None
        self.executed_params = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executed_sql = sql
        self.executed_params = params

    def fetchall(self):
        return self.rows


class DummyConn:
    def __init__(self, cursor):
        self.cursor_obj = cursor

    def cursor(self):
        return self.cursor_obj


@pytest.fixture
def dummy_conn_factory():
    def _factory(rows):
        cursor = DummyCursor(rows)
        return DummyConn(cursor), cursor

    return _factory


def test__search_passages_filters_by_doc_ids(monkeypatch, dummy_conn_factory):
    conn, cursor = dummy_conn_factory([
        ("段落1", "section/A", "Doc A", 0.75),
    ])
    monkeypatch.setattr(pageindex, "get_conn", lambda: conn)

    put_args = []

    def fake_put(c):
        put_args.append(c)

    monkeypatch.setattr(pageindex, "put_conn", fake_put)

    results = pageindex._search_passages([0.1, 0.2], doc_ids=[1, 2], passage_ids=None, threshold=0.5, limit=5)

    assert results[0]["source"] == "passage"
    assert "p.doc_id = ANY" in cursor.executed_sql
    assert cursor.executed_params[1] == [1, 2]
    assert put_args == [conn]


def test__search_passages_filters_by_passage_ids(monkeypatch, dummy_conn_factory):
    conn, cursor = dummy_conn_factory([
        ("段落B", "section/B", "Doc B", 0.88),
    ])
    monkeypatch.setattr(pageindex, "get_conn", lambda: conn)

    put_args = []

    def fake_put(c):
        put_args.append(c)

    monkeypatch.setattr(pageindex, "put_conn", fake_put)

    results = pageindex._search_passages([0.3], doc_ids=None, passage_ids=[10, 11], threshold=0.4, limit=2)

    assert results[0]["txt"] == "段落B"
    assert "p.id = ANY" in cursor.executed_sql
    assert cursor.executed_params[1] == [10, 11]
    assert put_args == [conn]


def test__search_passages_short_circuits_without_scope(monkeypatch):
    called = {"get_conn": 0}

    def fake_get_conn():
        called["get_conn"] += 1
        raise AssertionError("should not be called")

    monkeypatch.setattr(pageindex, "get_conn", fake_get_conn)

    assert pageindex._search_passages([0.1], doc_ids=None, passage_ids=None, threshold=0.5, limit=3) == []
    assert called["get_conn"] == 0


def test__search_verify_filters_by_qc_code(monkeypatch, dummy_conn_factory):
    conn, cursor = dummy_conn_factory([
        ("文本", "QC001", 0.91),
    ])
    monkeypatch.setattr(pageindex, "get_conn", lambda: conn)

    put_args = []

    def fake_put(c):
        put_args.append(c)

    monkeypatch.setattr(pageindex, "put_conn", fake_put)

    results = pageindex._search_verify([0.4], note_qc_code="QC001", threshold=0.6, limit=3)

    assert results[0]["note_qc_code"] == "QC001"
    assert "note_qc_code = %s" in cursor.executed_sql
    assert cursor.executed_params[1] == "QC001"
    assert put_args == [conn]


def test__search_verify_returns_empty_when_no_qc_code(monkeypatch):
    called = {"get_conn": 0}

    def fake_get_conn():
        called["get_conn"] += 1
        raise AssertionError("should not be called")

    monkeypatch.setattr(pageindex, "get_conn", fake_get_conn)

    assert pageindex._search_verify([0.1], note_qc_code=None, threshold=0.5, limit=3) == []
    assert called["get_conn"] == 0