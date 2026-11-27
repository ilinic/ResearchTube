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

    def test_export_and_request_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            trace=Trace()
            trace.root=root/"trace"
            trace.add({"event":"SQL_COMMITTED","requestId":"req-1","component":"agent","executionState":"committed","sql":"SECRET"})
            trace.add({"event":"AGENT_TOOL_COMPLETED","requestId":"req-1","component":"agent","executionState":"completed"})
            trace.add({"event":"OTHER","requestId":"req-2"})
            trace._flush()
            report=trace.query({"requestId":"req-1"})["requestReport"]
            self.assertEqual(report["executionState"],"committed")
            dest=root/"scheduled"/"reliability-trace.jsonl"
            result=trace.export(dest,{"requestId":"req-1"})
            self.assertEqual(result["events"],2)
            self.assertNotIn("SECRET",dest.read_text())
            self.assertNotIn("req-2",dest.read_text())
            import os
            os.utime(dest,(time.time()-3700,time.time()-3700))
            trace._flush()
            self.assertFalse(dest.exists())

    def test_disk_failure_does_not_stop_trace(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/"blocked"
            root.write_text("not a directory")
            trace=Trace()
            trace.root=root
            trace.add({"event":"TEST","requestId":"r"})
            with self.assertRaises(OSError):
                trace._flush()
            self.assertEqual(trace.query({"requestId":"r"})["events"][0]["event"],"TEST")


    def test_payload_summary_uses_verified_conversation_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            trace=Trace()
            trace.root=Path(directory)
            sample={"event":"MCP_PAYLOAD_SIZE","component":"extension","tool":"site_read","requestId":"req-one","conversationId":"chat-one","requestBytes":10,"resultBytes":1000,"structuredBytes":400,"textBytes":400,"duplicateBytes":400,"relayBytes":1100,"status":"forwarded"}
            trace.add(sample)
            trace.add(sample)
            trace.add({"event":"MCP_PAYLOAD_SIZE","tool":"db_query","requestId":"req-two","requestBytes":20,"resultBytes":600,"relayBytes":700,"status":"relay_limit"})
            trace.add({"event":"PLAN_PROMPT_SIZE","tool":"scheduler","conversationId":"chat-one","promptBytes":50})
            trace._flush()
            summary=trace.query({"includePayloadSummary":True,"limit":1})["payloadSummary"]
            self.assertEqual(summary["totals"]["calls"],2)
            self.assertEqual(summary["totals"]["resultBytes"],1600)
            self.assertEqual(summary["totals"]["unattributedCalls"],1)
            self.assertEqual(summary["totals"]["relayLimited"],1)
            self.assertEqual(summary["totals"]["promptBytes"],50)
            own=trace.query({"conversationId":"chat-one","includePayloadSummary":True})["payloadSummary"]["totals"]
            self.assertEqual(own["calls"],1)
            self.assertEqual(own["duplicateBytes"],400)
            self.assertEqual(own["promptBytes"],50)
