"""Reproducible isolated load test; never opens live Workspace.
Run from repo: python -m agent.tests.stress_reliability --seconds 1800 --clients 10
Use --seconds 2 for smoke only. Baseline and traced phases each run half the time.
"""
import argparse
import asyncio
import json
import math
from pathlib import Path
import tempfile
import time
import tracemalloc
from unittest.mock import patch

from agent import scheduled_memory as memory, reliability


def percentile(values,p):
    ordered=sorted(values)
    return ordered[max(0,math.ceil(len(ordered)*p/100)-1)] if ordered else None


async def phase(root,seconds,clients,enabled):
    resolve=lambda logical:root/"workspace"/logical
    resolve("scheduled").mkdir(parents=True)
    memory.initialize(resolve)
    memory.db_sql(resolve,"CREATE TABLE records(id TEXT PRIMARY KEY)")
    trace=reliability.Trace()
    trace.start(root/"trace")
    queue=memory.SqlQueue()
    latencies=[]
    expected=set()
    errors=[]
    end=time.monotonic()+seconds
    def emit(event,**fields):
        if enabled:trace.add({"component":"agent","tool":"db_sql","event":event,**fields})
    async def client(index):
        number=0
        while time.monotonic()<end:
            number+=1
            key=f"client-{index}-{number}"
            sql=f"INSERT INTO records VALUES('{key}')"
            started=time.monotonic()
            try:
                args={"sql":sql,"operationId":key}
                await queue.run(resolve,args)
                expected.add(key)
                # Simulate lost response after COMMIT by reissuing exact key.
                if number%10==0:await queue.run(resolve,args)
                if number%5==0:await queue.run(resolve,{"sql":"SELECT count(*) FROM records"})
            except Exception as error:
                errors.append(getattr(error,"code",type(error).__name__))
            latencies.append((time.monotonic()-started)*1000)
            await asyncio.sleep(.5)
    tracemalloc.start()
    try:
        with patch.object(memory,"emit",emit):
            await asyncio.gather(*(client(i) for i in range(clients)))
        count=memory.db_sql(resolve,"SELECT count(*) FROM records")["results"][0]["rows"][0][0]
        if count!=len(expected) or errors:raise AssertionError({"expected":len(expected),"actual":count,"errors":errors[:10]})
        current,peak=tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
        trace.close()
    disk=sum(p.stat().st_size for p in (root/"trace").glob("*.jsonl"))
    return {"clients":clients,"seconds":seconds,"operations":len(latencies),"uniqueRecords":count,
        "p50Ms":percentile(latencies,50),"p95Ms":percentile(latencies,95),"p99Ms":percentile(latencies,99),
        "pythonHeapCurrentBytes":current,"pythonHeapPeakBytes":peak,"traceDiskBytes":disk,
        "traceDropped":trace.dropped,"traceDiskErrors":trace.disk_errors}


async def main(seconds,clients):
    with tempfile.TemporaryDirectory(prefix="rt-reliability-test-") as directory:
        root=Path(directory)
        baseline=await phase(root/"baseline",seconds/2,clients,False)
        traced=await phase(root/"traced",seconds/2,clients,True)
        increase=traced["p95Ms"]-baseline["p95Ms"]
        threshold=max(1,baseline["p95Ms"]*.05)
        print(json.dumps({"baseline":baseline,"traced":traced,"p95IncreaseMs":increase,
            "targetMs":threshold,"targetMet":increase<=threshold,
            "smokeOnly":seconds<1800,"note":"Python heap, not whole-process RSS; local SQLite only, no browser/OAuth traffic."},indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--seconds",type=int,default=1800)
    parser.add_argument("--clients",type=int,default=10)
    args=parser.parse_args()
    if not 2<=args.seconds<=3600 or not 3<=args.clients<=10:parser.error("seconds 2–3600; clients 3–10")
    asyncio.run(main(args.seconds,args.clients))
