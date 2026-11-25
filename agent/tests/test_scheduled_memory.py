import tempfile
import unittest
from pathlib import Path

try:
    from agent import scheduled_memory as memory
except ImportError:
    import scheduled_memory as memory


class SharedMemoryTest(unittest.TestCase):
    def test_sql_and_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            resolve = lambda p: root / p
            memory.initialize(resolve)
            self.assertTrue(memory.db_sql(resolve, "CREATE TABLE t(x UNIQUE); INSERT INTO t VALUES ('a;b');")["success"])
            with self.assertRaises(memory.MemoryOperationError):
                memory.db_sql(resolve, "INSERT INTO t VALUES ('rollback'); INSERT INTO t VALUES ('a;b');")
            self.assertEqual(memory.db_sql(resolve, "SELECT x FROM t")["results"][0]["rows"], [["a;b"]])
            for sql in ("ATTACH DATABASE 'outside.sqlite' AS x", "VACUUM INTO 'outside.sqlite'",
                        "PRAGMA writable_schema=ON", "SELECT load_extension('x')", "BEGIN"):
                with self.assertRaises(memory.MemoryOperationError):
                    memory.db_sql(resolve, sql)
            self.assertTrue(memory.db_sql(resolve, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<300) SELECT x FROM c")["truncated"])
            memory.write_text(resolve, "scheduled/notes.md", "Привет")
            self.assertEqual(memory.read_text(resolve, "scheduled/notes.md")["text"], "Привет")
            memory.initialize(resolve)
            self.assertEqual(memory.db_sql(resolve, "SELECT count(*) FROM t")["results"][0]["rows"], [[1]])
