import unittest
import tempfile
from pathlib import Path
from agent import scheduled_memory as m
from agent import agent_plans as p

class AgentPlanTest(unittest.TestCase):
    def test_queue_skills_and_outbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            resolve=lambda name: Path(tmp)/name
            m.initialize(resolve)
            def write(name,a,key):
                m.outbox_submit(resolve,key,p.encode(name,a),internal_plan=True)
                self.assertTrue(m.outbox_process_one(resolve))
                return m.plan_operation_status(resolve,key)
            def read(name,a):
                return m.plan_read(resolve,name,a)
            c={"chat_id":"test-chat"}
            a={**c,"expected_version":0,"actions":[{"op":"add","prompt":"one"},{"op":"add","prompt":"two","delay_seconds":1000}]}
            self.assertEqual(write("plan_edit",a,"test.add")["state"],"committed")
            m.outbox_submit(resolve,"test.add",p.encode("plan_edit",a),internal_plan=True)
            s=read("__plan_peek",c)
            self.assertEqual(s["next"]["prompt"],"one")
            self.assertEqual(len(read("plan_read",c)["items"]),2)
            write("__plan_transition",{**c,"version":s["version"],"action":"observe","anchor":"u1:a1"},"test.observe")
            s=read("__plan_peek",c)
            i=s["next"]["id"]
            write("__plan_transition",{**c,"version":s["version"],"action":"claim","anchor":"u1:a1","id":i,"marker":"m1"},"test.claim")
            s=read("__plan_peek",c)
            self.assertEqual(s["current"]["status"],"claimed")
            write("__plan_transition",{**c,"version":s["version"],"action":"dispatch","id":i,"marker":"m1"},"test.dispatch")
            s=read("__plan_peek",c)
            write("__plan_transition",{**c,"version":s["version"],"action":"finish","anchor":"u2:a2","id":i,"marker":"m1"},"test.finish")
            s=read("__plan_peek",c)
            self.assertEqual(s["next"]["delay_seconds"],1000)
            self.assertIsNone(s["current"])
            skill=write("skill_create",{"name":"Research","content":"# Method","actor":"test-chat"},"test.skill")
            self.assertEqual(skill["state"],"committed")
            i=read("skill_list",{})["items"][0]["id"]
            write("skill_update",{"id":i,"expected_version":1,"content":"# Improved"},"test.update")
            self.assertEqual(read("skill_read",{"id":i,"version":1})["skill"]["content"],"# Method")
            self.assertEqual(read("skill_read",{"id":i})["skill"]["version"],2)
            self.assertEqual(write("skill_update",{"id":i,"expected_version":1,"content":"stale"},"test.stale")["state"],"failed_permanent")
            with self.assertRaises(m.MemoryOperationError):
                m.db_query(resolve,"SELECT * FROM _rt_internal_plans")

if __name__=="__main__":
    unittest.main()
