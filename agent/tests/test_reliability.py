import json
import tempfile
import time
import unittest
from pathlib import Path

try:
    from agent.reliability import Trace
except ImportError:
    from reliability import Trace


class ReliabilityTraceTest(unittest.TestCase):
    def test_privacy_retention_disk_and_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            trace=Trace(max_bytes=65536,max_events=200,ttl=3600,segment_bytes=4096,disk_bytes=16384)
            trace.root=Path(directory)
            for i in range(1000):
                trace.add({"component":"agent","tool":"db_sql","requestId":f"req-{i}","event":"AGENT_TOOL_COMPLETED","durationMs":i,"sql":"SECRET","token":"SECRET","path":"/private"})
            trace.add({"component":"agent","tool":"db_sql","event":"SQL_FAILED","level":"ERROR","requestId":"error","code":"DB_BUSY"})
            trace._flush()
            page=trace.query({"limit":5,"includeSummary":True})
            self.assertTrue(page["truncated"])
            self.assertTrue(page["summary"])
            self.assertTrue(page["dropped"]>0)
            second=trace.query({"limit":5,"cursor":page["nextCursor"]})
            self.assertFalse(set(x["eventId"] for x in page["events"]) & set(x["eventId"] for x in second["events"]))
            self.assertTrue(trace.query({"requestId":"error"})["events"])
            self.assertLessEqual(sum(p.stat().st_size for p in trace.root.glob("*.jsonl")),16384)
            self.assertNotIn("SECRET",json.dumps(page))
            self.assertNotIn("SECRET", "".join(p.read_text() for p in trace.root.glob("*.jsonl")))
            trace.add({"event":"EXPIRED","atMs":(time.time()-3601)*1000})
            self.assertFalse(any(e["event"]=="EXPIRED" for e in trace.query({"limit":100})["events"]))
