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
        self.private=memory.SharedMemoryPath(self.root/"shared-memory",self.workspace)
        memory.initialize(self.research)
        memory.initialize(self.private)

    def submit(self,key,content,topic="",**extra):
        return memory.call(self.private,"__memory_submit",{"operation_id":key,"content":content,"topic":topic,**extra})

    def process(self):
        return memory.call(self.private,"__outbox_process",{})

    def read(self,**args):
        return memory.call(self.private,"memory_read",args)

    def status(self,key):
        return memory.call(self.private,"__memory_status",{"operation_id":key})

    def test_exact_text_dedup_and_restart(self):
        content="  Свёкла; 'quotes'\n\x00😀\n"
        self.assertEqual(self.submit("a",content," SHOPPING ",source_chat="chat-a")["state"],"pending")
        self.assertEqual(self.read()["items"],[])
        # Simulate interruption after claiming the durable outbox record.
        self.assertEqual(memory.outbox_claim(self.private)["operationId"],"a")
        self.private=memory.SharedMemoryPath(self.root/"shared-memory",self.workspace)
        memory.initialize(self.private)
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

    def test_separate_db_and_parallel_admission(self):
        self.assertNotEqual(self.private(memory.DB_FILE),self.research(memory.DB_FILE))
        memory.outbox_submit(self.research,"same","CREATE TABLE ms_listings(x); INSERT INTO ms_listings VALUES(1)")
        self.submit("same","shared")
        self.assertTrue(memory.outbox_process_one(self.research))
        self.assertTrue(self.process())
        self.assertEqual(memory.db_query(self.research,"SELECT x FROM ms_listings")["results"][0]["rows"],[[1]])
        with self.assertRaises(memory.MemoryOperationError):
            memory.call(self.private,"db_query",{"sql":"SELECT * FROM shared_memory"})
        with self.assertRaises(memory.MemoryOperationError):
            memory.call(self.research,"memory_read",{})
        self.assertFalse(any(row[0]=="shared_memory" for row in memory.db_query(self.research,"SELECT name FROM sqlite_master")["results"][0]["rows"]))
        async def run():
            queue=memory.SqlQueue()
            results=await asyncio.gather(*(queue.run(self.private,{"operation_id":f"op{i}","content":str(i)},"__memory_submit") for i in range(25)))
            self.assertTrue(all(r["state"]=="pending" for r in results))
            for _ in results:
                self.assertTrue(await queue.run(self.private,{},"__outbox_process"))
        asyncio.run(run())
        self.assertEqual(len(self.read(limit=100)["items"]),26)

    def test_limits_and_private_location(self):
        for content in ("", "   ","é"*8193):
            with self.assertRaises(memory.MemoryOperationError):
                self.submit("invalid",content)
        for args in ({"limit":101},{"after_id":-1},{"after_id":0,"before_id":3}):
            with self.assertRaises(memory.MemoryOperationError):
                self.read(**args)
        with self.assertRaises(memory.MemoryOperationError):
            memory.initialize(memory.SharedMemoryPath(self.workspace/"private",self.workspace))
        self.assertEqual(self.read()["items"],[])
        self.submit("large","я"*8192)
        self.process()
        self.assertEqual(len(self.read()["items"][0]["content"].encode("utf-8")),16384)
