import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path

from agent import scheduled_memory as memory


class CrossChatMemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.workspace=self.root/"workspace"
        self.workspace.mkdir()
        self.research=lambda logical:self.workspace/logical
        memory.initialize(self.research)

    def submit(self,key,content,topic="",**extra):
        return memory.call(self.research,"__memory_submit",{"operation_id":key,"content":content,"topic":topic,**extra})

    def process(self):
        return memory.call(self.research,"__outbox_process",{})

    def read(self,**args):
        return memory.call(self.research,"memory_read",args)

    def status(self,key):
        return memory.call(self.research,"__memory_status",{"operation_id":key})

    def test_exact_text_dedup_and_restart(self):
        content="  Свёкла; 'quotes'\n\x00😀\n"
        self.assertEqual(self.submit("a",content," SHOPPING ",source_chat="chat-a")["state"],"pending")
        self.assertEqual(self.read()["items"],[])
        # Simulate interruption after claiming the durable outbox record.
        self.assertEqual(memory.outbox_claim(self.research)["operationId"],"a")
        memory.initialize(self.research)
        self.assertTrue(self.process())
        first=self.status("a")
        self.assertEqual(first["state"],"committed")
        self.assertEqual(self.submit("a",content,"shopping",source_chat="chat-a")["state"],"committed")
        self.assertEqual(self.status("a"),first)
        self.assertFalse(self.process())
        with self.assertRaises(memory.MemoryOperationError) as conflict:
            self.submit("a","different","shopping",source_chat="chat-a")
        self.assertEqual(conflict.exception.code,"DB_OPERATION_CONFLICT")
        items=self.read(topic="shopping")["items"]
        self.assertEqual(len(items),1)
        self.assertEqual(items[0]["content"],content)
        self.assertEqual(items[0]["source_chat"],"chat-a")
        self.assertEqual(items[0]["id"],first["id"])

    def test_cursors_and_topics(self):
        for i in range(25):
            self.submit(f"k{i}",str(i),"shopping" if i%2 else "")
            self.process()
        recent=self.read(limit=5)
        self.assertEqual([x["content"] for x in recent["items"]],["20","21","22","23","24"])
        self.assertTrue(recent["has_more"])
        older=self.read(before_id=recent["next_before_id"],limit=5)
        self.assertEqual([x["content"] for x in older["items"]],["15","16","17","18","19"])
        page=self.read(after_id=0,limit=3,topic="shopping")
        self.assertEqual([x["content"] for x in page["items"]],["1","3","5"])
        next_page=self.read(after_id=page["next_after_id"],limit=3,topic="shopping")
        self.assertEqual([x["content"] for x in next_page["items"]],["7","9","11"])
        self.assertTrue(all(x["topic"]=="" for x in self.read(topic="")["items"]))

    def test_one_database_one_queue_and_global_operation_ids(self):
        memory.outbox_submit(self.research,"same","CREATE TABLE ms_listings(x); INSERT INTO ms_listings VALUES(1)")
        with self.assertRaises(memory.MemoryOperationError) as conflict:
            self.submit("same","shared")
        self.assertEqual(conflict.exception.code,"DB_OPERATION_CONFLICT")
        self.submit("memory-1","shared")
        self.assertEqual(memory.outbox_status(self.research,"memory-1")["state"],"pending")
        self.assertEqual(len(memory.outbox_list(self.research)["items"]),2)
        self.assertTrue(self.process())
        self.assertTrue(self.process())
        self.assertEqual(memory.db_query(self.research,"SELECT x FROM ms_listings")["results"][0]["rows"],[[1]])
        self.assertEqual(self.status("memory-1")["state"],"committed")
        self.assertTrue(memory.outbox_status(self.research,"memory-1")["acknowledged"])
        with sqlite3.connect(self.research(memory.DB_FILE)) as con:
            self.assertEqual(con.execute("SELECT content FROM shared_memory").fetchall(),[("shared",)])
        with self.assertRaises(memory.MemoryOperationError):
            memory.call(self.research,"db_query",{"sql":"SELECT * FROM shared_memory"})
        for sql in ("DELETE FROM shared_memory","DROP TABLE shared_memory","DROP INDEX idx_shared_memory_topic_id"):
            with self.assertRaises(memory.MemoryOperationError):
                memory._execute_write(self.research,sql,"protected-"+sql.split()[0]+sql.split()[-1])
        with self.assertRaises(memory.MemoryOperationError):
            memory.outbox_submit(self.research,"forged",memory.memory_payload({"content":"forged"}))
        async def run():
            queue=memory.SqlQueue()
            reads=memory.ReadQueue()
            jobs=[]
            for i in range(25):
                jobs.append(queue.run(self.research,{"operation_id":f"op{i}","content":str(i)},"__memory_submit"))
                jobs.append(queue.run(self.research,{"operationId":f"sql{i}","sql":f"INSERT INTO ms_listings VALUES({i})"},"db_outbox_submit"))
            results=await asyncio.gather(*jobs)
            self.assertTrue(all(r["state"]=="pending" for r in results))
            for _ in results:
                self.assertTrue(await queue.run(self.research,{},"__outbox_process"))
            self.assertEqual(queue.depth,0)
            self.assertEqual(len((await reads.run(self.research,{"limit":100},"memory_read"))["items"]),26)
        asyncio.run(run())
        self.assertEqual(memory.db_query(self.research,"SELECT count(*) FROM ms_listings")["results"][0]["rows"],[[26]])

    def test_initialize_existing_database_preserves_data(self):
        with sqlite3.connect(self.research(memory.DB_FILE)) as con:
            con.execute("CREATE TABLE existing_data(x)")
            con.execute("INSERT INTO existing_data VALUES(42)")
            con.execute("DROP TABLE shared_memory")
        memory.initialize(self.research)
        self.assertEqual(memory.db_query(self.research,"SELECT x FROM existing_data")["results"][0]["rows"],[[42]])
        self.assertEqual(self.read()["items"],[])

    def test_limits(self):
        for content in ("", "   ","é"*8193):
            with self.assertRaises(memory.MemoryOperationError):
                self.submit("invalid",content)
        for args in ({"limit":101},{"after_id":-1},{"after_id":0,"before_id":3}):
            with self.assertRaises(memory.MemoryOperationError):
                self.read(**args)
        self.assertEqual(self.read()["items"],[])
        self.submit("large","я"*8192)
        self.process()
        self.assertEqual(len(self.read()["items"][0]["content"].encode("utf-8")),16384)
