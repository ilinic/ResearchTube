import asyncio
import sqlite3
import tempfile
import threading
import time
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
            self.assertTrue(memory.db_sql(resolve, "ALTER TABLE t ADD COLUMN y INTEGER; UPDATE t SET y=1 RETURNING y;")["success"])
            self.assertTrue(memory.db_sql(resolve, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<300) SELECT x FROM c")["truncated"])
            memory.write_text(resolve, "scheduled/notes.md", "Привет")
            self.assertEqual(memory.read_text(resolve, "scheduled/notes.md")["text"], "Привет")
            memory.initialize(resolve)
            self.assertEqual(memory.db_sql(resolve, "SELECT count(*) FROM t")["results"][0]["rows"], [[1]])

    def test_atomic_operation_id_and_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            memory.db_sql(resolve,"CREATE TABLE t(x)")
            sql="INSERT INTO t VALUES(1); SELECT count(*) FROM t"
            first=memory.db_sql(resolve,sql,"same-key")
            memory.initialize(resolve)
            self.assertEqual(memory.db_sql(resolve,sql,"same-key"),first)
            self.assertEqual(memory.db_sql(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])
            with self.assertRaises(memory.MemoryOperationError) as conflict:
                memory.db_sql(resolve,"INSERT INTO t VALUES(2)","same-key")
            self.assertEqual(conflict.exception.code,"DB_OPERATION_CONFLICT")
            self.assertEqual(conflict.exception.executionState,"rolled_back")
            for query in ("SELECT * FROM _rt_internal_operations","DELETE FROM _rt_internal_operations","DROP TABLE _rt_internal_operations"):
                with self.assertRaises(memory.MemoryOperationError):
                    memory.db_sql(resolve,query)
            with self.assertRaises(memory.MemoryOperationError):
                memory.db_sql(resolve,"INSERT INTO t VALUES(5); SELECT * FROM missing","bad-key")
            self.assertEqual(memory.db_sql(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])

    def test_concurrent_agents_and_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            memory.db_sql(resolve,"CREATE TABLE t(x UNIQUE)")
            async def run():
                queue=memory.SqlQueue(4096)
                results=await asyncio.gather(*(queue.run(resolve,{"sql":f"INSERT INTO t VALUES({i})","operationId":f"op-{i}"}) for i in range(100)))
                self.assertTrue(all(result["success"] for result in results))
                self.assertEqual(queue.depth,0)
            asyncio.run(run())
            self.assertEqual(memory.db_sql(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[100]])

    def test_temporary_external_writer_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            memory.db_sql(resolve,"CREATE TABLE t(x)")
            con=sqlite3.connect(resolve(memory.DB_FILE),check_same_thread=False,isolation_level=None)
            con.execute("BEGIN IMMEDIATE")
            def release():
                time.sleep(.75)
                con.rollback()
            thread=threading.Thread(target=release)
            thread.start()
            try:
                result=memory.db_sql(resolve,"INSERT INTO t VALUES(1)","locked")
                self.assertTrue(result["success"])
            finally:
                thread.join()
                con.close()
            self.assertEqual(memory.db_sql(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])
