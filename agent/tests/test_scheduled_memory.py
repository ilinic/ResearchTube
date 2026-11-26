import asyncio
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

try:
    from agent import scheduled_memory as memory
except ImportError:
    import scheduled_memory as memory


def fixture_write(resolve,sql,operation_id=None):
    # Internal execution tests use a unique key even for schema setup.
    return memory._execute_write(resolve,sql,operation_id or uuid.uuid4().hex)


class SharedMemoryTest(unittest.TestCase):
    def test_sql_and_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            resolve = lambda p: root / p
            memory.initialize(resolve)
            self.assertTrue(fixture_write(resolve, "CREATE TABLE t(x UNIQUE); INSERT INTO t VALUES ('a;b');")["success"])
            with self.assertRaises(memory.MemoryOperationError):
                fixture_write(resolve, "INSERT INTO t VALUES ('rollback'); INSERT INTO t VALUES ('a;b');")
            self.assertEqual(memory.db_query(resolve, "SELECT x FROM t")["results"][0]["rows"], [["a;b"]])
            for sql in ("ATTACH DATABASE 'outside.sqlite' AS x", "VACUUM INTO 'outside.sqlite'",
                        "PRAGMA writable_schema=ON", "SELECT load_extension('x')", "BEGIN"):
                with self.assertRaises(memory.MemoryOperationError):
                    fixture_write(resolve, sql)
            self.assertTrue(fixture_write(resolve, "ALTER TABLE t ADD COLUMN y INTEGER; UPDATE t SET y=1 RETURNING y;")["success"])
            self.assertTrue(memory.db_query(resolve, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<300) SELECT x FROM c")["truncated"])
            memory.write_text(resolve, "scheduled/notes.md", "Привет")
            self.assertEqual(memory.read_text(resolve, "scheduled/notes.md")["text"], "Привет")
            memory.initialize(resolve)
            self.assertEqual(memory.db_query(resolve, "SELECT count(*) FROM t")["results"][0]["rows"], [[1]])

    def test_atomic_operation_id_and_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE t(x)")
            sql="INSERT INTO t VALUES(1); SELECT count(*) FROM t"
            first=fixture_write(resolve,sql,"same-key")
            memory.initialize(resolve)
            self.assertEqual(fixture_write(resolve,sql,"same-key"),first)
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])
            with self.assertRaises(memory.MemoryOperationError) as conflict:
                fixture_write(resolve,"INSERT INTO t VALUES(2)","same-key")
            self.assertEqual(conflict.exception.code,"DB_OPERATION_CONFLICT")
            self.assertEqual(conflict.exception.executionState,"rolled_back")
            for query in ("SELECT * FROM _rt_internal_operations","DELETE FROM _rt_internal_operations","DROP TABLE _rt_internal_operations"):
                with self.assertRaises(memory.MemoryOperationError):
                    fixture_write(resolve,query)
            with self.assertRaises(memory.MemoryOperationError):
                fixture_write(resolve,"INSERT INTO t VALUES(5); SELECT * FROM missing","bad-key")
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])

    def test_concurrent_agents_and_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE t(x UNIQUE)")
            async def run():
                queue=memory.SqlQueue(4096)
                results=await asyncio.gather(*(queue.run(resolve,{"sql":f"INSERT INTO t VALUES({i})","operationId":f"op-{i}"},"db_outbox_submit") for i in range(100)))
                self.assertTrue(all(result["state"]=="pending" for result in results))
                for _ in range(100):
                    self.assertTrue(await queue.run(resolve,{},"__outbox_process"))
                self.assertEqual(queue.depth,0)
            asyncio.run(run())
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[100]])

    def test_temporary_external_writer_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE t(x)")
            con=sqlite3.connect(resolve(memory.DB_FILE),check_same_thread=False,isolation_level=None)
            con.execute("BEGIN IMMEDIATE")
            def release():
                time.sleep(.75)
                con.rollback()
            thread=threading.Thread(target=release)
            thread.start()
            try:
                result=fixture_write(resolve,"INSERT INTO t VALUES(1)","locked")
                self.assertTrue(result["success"])
            finally:
                thread.join()
                con.close()
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])

    def test_outbox_recovery_and_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE t(x UNIQUE)")
            sql="INSERT INTO t VALUES(1)"
            self.assertEqual(memory.outbox_submit(resolve,"pack-1",sql)["state"],"pending")
            self.assertEqual(memory.outbox_submit(resolve,"pack-1",sql)["state"],"pending")
            with self.assertRaises(memory.MemoryOperationError):
                memory.outbox_submit(resolve,"pack-1","INSERT INTO t VALUES(2)")
            # Simulate process interruption after claim and before execution.
            claimed=memory.outbox_claim(resolve)
            self.assertEqual(claimed["operationId"],"pack-1")
            self.assertEqual(memory.outbox_status(resolve,"pack-1")["state"],"processing")
            memory.initialize(resolve)
            self.assertTrue(memory.outbox_process_one(resolve))
            self.assertEqual(memory.outbox_status(resolve,"pack-1")["state"],"committed")
            # Simulate lost response after commit; use the same key.
            self.assertEqual(memory.outbox_submit(resolve,"pack-1",sql)["state"],"committed")
            self.assertFalse(memory.outbox_process_one(resolve))
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[1]])
            self.assertTrue(memory.outbox_ack(resolve,"pack-1")["acknowledged"])
            self.assertEqual(memory.outbox_list(resolve)["items"],[])
            self.assertEqual(memory.outbox_submit(resolve,"pack-1",sql)["state"],"committed")
            self.assertTrue(memory.outbox_ack(resolve,"pack-1")["acknowledged"])
            with self.assertRaises(memory.MemoryOperationError):
                fixture_write(resolve,"SELECT * FROM _rt_internal_outbox")

    def test_failed_outbox_preserves_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE t(x)")
            memory.outbox_submit(resolve,"invalid","INSERT INTO t VALUES(1); SELECT * FROM missing")
            self.assertTrue(memory.outbox_process_one(resolve))
            self.assertEqual(memory.outbox_status(resolve,"invalid")["state"],"failed_permanent")
            self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM t")["results"][0]["rows"],[[0]])
            self.assertFalse(memory.outbox_process_one(resolve))
            with self.assertRaises(memory.MemoryOperationError):
                memory.outbox_ack(resolve,"invalid")
            self.assertEqual(len(memory.outbox_list(resolve)["items"]),1)

    def test_query_enforces_read_only_and_legacy_tool_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            memory.outbox_submit(resolve,"setup","CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1)")
            self.assertTrue(memory.outbox_process_one(resolve))
            self.assertEqual(memory.db_query(resolve,"SELECT id FROM records")["results"][0]["rows"],[[1]])
            self.assertTrue(memory.db_query(resolve,"PRAGMA table_info(records)")["results"][0]["rows"])
            self.assertEqual(memory.db_query(resolve,"WITH c AS (SELECT id FROM records) SELECT * FROM c")["results"][0]["rows"],[[1]])
            for sql in ("INSERT INTO records VALUES(2)", "WITH c AS (SELECT 2) INSERT INTO records SELECT * FROM c",
                        "UPDATE records SET id=2","DELETE FROM records","DROP TABLE records","CREATE TABLE other(x)",
                        "ALTER TABLE records ADD COLUMN y","PRAGMA user_version=4","PRAGMA query_only=OFF",
                        "ATTACH DATABASE 'external.db' AS other","SELECT * FROM _rt_internal_outbox",
                        "SELECT * FROM _rt_internal_operations","SELECT 1; DELETE FROM records",
                        "EXPLAIN DELETE FROM records","BEGIN","VACUUM"):
                with self.subTest(sql=sql),self.assertRaises(memory.MemoryOperationError):
                    memory.call(resolve,"db_query",{"sql":sql})
            with self.assertRaises(memory.MemoryOperationError):
                memory.call(resolve,"db_sql",{"sql":"INSERT INTO records VALUES(2)"})
            with self.assertRaises(memory.MemoryOperationError):
                memory.call(resolve,"db_query",{"sql":"SELECT 1","operationId":"unsupported"})
            self.assertEqual(memory.db_query(resolve,"SELECT id FROM records")["results"][0]["rows"],[[1]])

    def test_readers_do_not_wait_for_write_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            memory.initialize(resolve)
            fixture_write(resolve,"CREATE TABLE records(id); INSERT INTO records VALUES(1)")
            con=sqlite3.connect(resolve(memory.DB_FILE),isolation_level=None)
            try:
                con.execute("BEGIN IMMEDIATE")
                con.execute("INSERT INTO records VALUES(2)")
                async def read_all():
                    reads=memory.ReadQueue(8)
                    return await asyncio.wait_for(asyncio.gather(*(reads.run(resolve,{"sql":"SELECT count(*) FROM records"}) for _ in range(16))),5)
                with memory._DB_LOCK:
                    results=asyncio.run(read_all())
                self.assertTrue(all(r["results"][0]["rows"]==[[1]] for r in results))
                con.commit()
                self.assertEqual(memory.db_query(resolve,"SELECT count(*) FROM records")["results"][0]["rows"],[[2]])
            finally:
                con.close()

    def test_missing_read_database_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as directory:
            resolve=lambda p: Path(directory)/p
            with self.assertRaises(memory.MemoryOperationError):
                memory.db_query(resolve,"SELECT 1")
            self.assertFalse(resolve(memory.DB_FILE).exists())
