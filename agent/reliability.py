"""Local, bounded reliability journal. No payload, SQL, URLs, raw exceptions or paths."""
from __future__ import annotations

from collections import deque
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import math
import os
import tempfile
from pathlib import Path
import re
import threading
import time
import uuid

REQUEST = ContextVar("reliability_request", default=None)
TOKEN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
TEXT_FIELDS = frozenset(("requestId", "tool", "component", "event", "level", "instanceId", "version", "code", "sqliteName", "stage", "method", "status", "executionState", "exceptionType", "schedulerTickId", "taskId", "operationId"))
NUM_FIELDS = frozenset(("attempt", "tabId", "chatTabId", "groupId", "durationMs", "monoMs", "atMs", "bytes", "statementCount", "statementIndex", "rowsAffected", "sqliteCode", "httpStatus", "queueDepth"))
INSTANCE = uuid.uuid4().hex


def safe_fields(values):
    output = {}
    for key, value in values.items():
        if key in TEXT_FIELDS and isinstance(value, str) and TOKEN.fullmatch(value):
            output[key] = value
        elif key in NUM_FIELDS and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            output[key] = value
    return output


class Buffer:
    def __init__(self, byte_limit, count_limit):
        self.items = deque()
        self.bytes = 0
        self.byte_limit = byte_limit
        self.count_limit = count_limit

    def expire(self, cutoff):
        while self.items and self.items[0][0] < cutoff:
            self.bytes -= len(self.items.popleft()[1])

    def append(self, item):
        size = len(item[1])
        dropped = 0
        if size > self.byte_limit:
            return 1
        while self.items and (self.bytes+size > self.byte_limit or len(self.items) >= self.count_limit):
            self.bytes -= len(self.items.popleft()[1])
            dropped += 1
        self.items.append(item)
        self.bytes += size
        return dropped

    def drain(self):
        items = list(self.items)
        self.items.clear()
        self.bytes = 0
        return items


class Trace:
    def __init__(self, max_bytes=16*1024*1024, max_events=25000, ttl=3600, segment_bytes=4*1024*1024, disk_bytes=64*1024*1024):
        self.ttl, self.segment_bytes, self.disk_bytes = ttl, segment_bytes, disk_bytes
        # Reserve 1/8 for failures; history and pending share the remaining
        # budget conservatively. Counts and serialized bytes are both bounded.
        half = max_bytes//2
        count = max(2, max_events//2)
        reserve, reserved_count = max(1,half//8), max(1,count//8)
        self.history = (Buffer(half-reserve,count-reserved_count),Buffer(reserve,reserved_count))
        self.pending = (Buffer(half-reserve,count-reserved_count),Buffer(reserve,reserved_count))
        self.dropped = self.disk_errors = 0
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.thread = None
        self.root = None
        self.sequence = 0
        self.export_lock = threading.Lock()
        self.export_path = None

    def _expire(self, now):
        for buffer in (*self.history, *self.pending):
            buffer.expire(now-self.ttl)

    def add(self, values):
        try:
            event = safe_fields(values)
            if not event.get("event"):
                return
            now = time.time()
            at = event.get("atMs", now*1000)
            if abs(at-now*1000) > self.ttl*1000:
                return
            event["atMs"] = at
            event["ts"] = datetime.fromtimestamp(at/1000, timezone.utc).isoformat()
            with self.lock:
                self.sequence += 1
                event["eventId"] = f"{INSTANCE}:{self.sequence}"
                data = (json.dumps(event,separators=(",",":"),allow_nan=False)+"\n").encode()
                if len(data)>4096:
                    self.dropped+=1
                    return
                self._expire(now)
                priority = int(event.get("level") in ("WARN","ERROR"))
                item=(now,data)
                self.dropped += self.history[priority].append(item)
                self.dropped += self.pending[priority].append(item)
                if sum(b.bytes for b in self.pending)>=256*1024 or priority:
                    self.wake.set()
        except Exception:
            return

    def start(self, root):
        if self.thread and self.thread.is_alive():
            return
        self.root=Path(root)
        self.stop.clear()
        self.thread=threading.Thread(target=self._writer,name="reliability-writer",daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread:
            self.thread.join(2)

    def _segments(self):
        if self.root is None:
            return []
        return sorted((p for p in self.root.glob("trace-*.jsonl") if re.fullmatch(r"trace-\d{20}-[a-f0-9]{32}\.jsonl",p.name) and not p.is_symlink()),key=lambda p:p.name)

    def _flush(self):
        self.root.mkdir(parents=True,exist_ok=True)
        cutoff=time.time()-self.ttl
        with self.export_lock:
            if self.export_path is not None and not self.export_path.is_symlink() and self.export_path.is_file() and self.export_path.stat().st_mtime < cutoff:
                self.export_path.unlink()
        segments=[]
        for path in self._segments():
            # Use the segment's creation time rather than mtime: a slowly
            # appended segment must not keep expired events indefinitely.
            try:
                created=int(path.name.split("-")[1])/1e9
            except (ValueError,IndexError):
                continue
            if created < cutoff:
                path.unlink()
            else:
                segments.append([path,path.stat().st_size])
        total=sum(size for _,size in segments)
        while segments and total>self.disk_bytes:
            path,size=segments.pop(0);path.unlink();total-=size
        with self.lock:
            self._expire(time.time())
            batch=sorted((item for buffer in self.pending for item in buffer.drain()),key=lambda item:item[0])
        try:
            index=0
            while index<len(batch):
                if not segments or segments[-1][1]+len(batch[index][1])>self.segment_bytes or time.time()-int(segments[-1][0].name.split("-")[1])/1e9>300:
                    segments.append([self.root/("trace-%020d-%s.jsonl"%(time.time_ns(),INSTANCE)),0])
                target=segments[-1]
                chunk=[]
                size=0
                while index<len(batch) and size+len(batch[index][1])+target[1]<=self.segment_bytes:
                    data=batch[index][1]
                    chunk.append(data);size+=len(data);index+=1
                if not chunk:
                    raise OSError("invalid segment budget")
                while len(segments)>1 and total+size>self.disk_bytes:
                    path,old=segments.pop(0);path.unlink();total-=old
                if total+size>self.disk_bytes:
                    # Smaller custom disk budgets cannot fit the segment.
                    raise OSError("diagnostic disk budget")
                with target[0].open("ab") as stream:
                    stream.write(b"".join(chunk))
                target[1]+=size;total+=size
        except OSError:
            with self.lock:
                self.dropped+=len(batch)
            raise

    def _writer(self):
        # Also expire old segments at startup, even without incoming events.
        while True:
            try:
                self._flush()
            except Exception:
                with self.lock:
                    self.disk_errors+=1
                if not self.stop.is_set():
                    self.stop.wait(30)
            if self.stop.is_set():
                return
            self.wake.wait(30);self.wake.clear()
            if not self.stop.is_set():
                self.stop.wait(1)

    def query(self, filters):
        limit=filters.get("limit",50)
        if type(limit) is not int or not 1<=limit<=100:
            raise ValueError("invalid limit")
        since=max(time.time()*1000-self.ttl*1000,filters.get("sinceMs",0))
        cursor=filters.get("cursor")
        before=None
        if cursor:
            stamp,event_id=cursor.split("|",1)
            before=(float(stamp),event_id)
        with self.lock:
            self._expire(time.time())
            snapshot=[data for buffer in self.history for _,data in buffer.items]
            dropped,disk_errors=self.dropped,self.disk_errors
        # Disk is only read on explicit diagnostic queries. Keep at most one
        # page of matches and avoid duplicate records between disk and RAM.
        import heapq
        page=[]
        selected=set()
        aggregate=filters.get("includeSummary",False)
        seen=set()
        stats={}
        def consider(data):
            try:
                event=json.loads(data)
                key=(event["atMs"],event["eventId"])
                if not since<=key[0] or (before is not None and key>=before):
                    return
                if any(filters.get(k) is not None and filters[k]!=event.get(k) for k in ("requestId","component","tool","code","level","tabId","chatTabId","groupId","taskId")):
                    return
                if key in selected:
                    return
                if aggregate and key not in seen:
                    seen.add(key)
                    label=(event.get("component","unknown"),event.get("tool","unknown"))
                    if len(stats)<256 or label in stats:
                        item=stats.setdefault(label,{"events":0,"errors":0,"completed":0,"failed":0,"retries":0,"maxQueueDepth":0,"durations":[]})
                        item["events"]+=1
                        item["errors"]+=int(event.get("level")=="ERROR")
                        kind=event.get("event","")
                        item["retries"]+=int(kind=="RETRY_STARTED")
                        item["maxQueueDepth"]=max(item["maxQueueDepth"],event.get("queueDepth",0))
                        if kind in ("AGENT_TOOL_COMPLETED","EXTENSION_TOOL_COMPLETED"):
                            item["completed"]+=1
                            if isinstance(event.get("durationMs"),(int,float)) and len(item["durations"])<25000:
                                item["durations"].append(event["durationMs"])
                        if kind in ("AGENT_TOOL_FAILED","EXTENSION_TOOL_FAILED"):
                            item["failed"]+=1
                if len(page)<limit+1:
                    heapq.heappush(page,(key,event));selected.add(key)
                elif key>page[0][0]:
                    old,_=heapq.heapreplace(page,(key,event));selected.remove(old);selected.add(key)
            except (ValueError,TypeError,KeyError):
                return
        for data in snapshot:
            consider(data)
        try:
            for path in self._segments():
                try:
                    with path.open("rb") as stream:
                        for data in stream:
                            if data.endswith(b"\n") and len(data)<=4096:
                                consider(data)
                except OSError:
                    continue
        except OSError:
            pass
        ordered=sorted(page,reverse=True)
        events=[event for _,event in ordered[:limit]]
        next_cursor=f"{events[-1]['atMs']}|{events[-1]['eventId']}" if len(ordered)>limit else None
        result={"events":events,"retained":len(snapshot),"returned":len(events),"truncated":next_cursor is not None,"nextCursor":next_cursor,"dropped":dropped,"diskErrors":disk_errors}
        if filters.get("requestId"):
            chain=sorted((event for _,event in page),key=lambda event:(event["atMs"],event["eventId"]))
            terminal=next((event.get("executionState") for event in reversed(chain) if event.get("executionState") in ("committed","rolled_back","not_started","unknown")),None)
            if terminal is None and any(event.get("executionState")=="completed" for event in chain):
                terminal="completed"
            result["requestReport"]={"lastEvent":chain[-1]["event"] if chain else None,"lastAtMs":chain[-1]["atMs"] if chain else None,"executionState":terminal or "unknown","observedStages":list(dict.fromkeys(e["event"] for e in chain)),"attempts":max((e.get("attempt",1) for e in chain),default=0),"scope":"retained page only; no proof of ChatGPT receipt"}
        if aggregate:
            summary=[]
            for (component,tool),item in stats.items():
                durations=sorted(item.pop("durations"))
                percentiles={f"p{p}Ms":durations[max(0,math.ceil(len(durations)*p/100)-1)] if durations else None for p in (50,95,99)}
                summary.append({"component":component,"tool":tool,**item,**percentiles,"durationSamples":len(durations)})
            result["summary"]=sorted(summary,key=lambda item:(-item["errors"],-item["events"],item["tool"]))[:100]
        return result

    def export(self, path, filters):
        """Single replaceable export, up to 4 MiB; no unrestricted path input."""
        limit=4*1024*1024
        cutoff=time.time()*1000-self.ttl*1000
        since=max(cutoff,filters.get("sinceMs",0))
        with self.export_lock:
            with self.lock:
                self._expire(time.time())
                snapshot=[data for buffer in self.history for _,data in buffer.items]
            path=Path(path)
            path.parent.mkdir(parents=True,exist_ok=True)
            if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_nlink!=1)):
                raise ValueError("unsafe export path")
            count=used=0
            seen=set()
            truncated=False
            fd,temp=tempfile.mkstemp(prefix=".rt-trace-",dir=path.parent)
            try:
                with os.fdopen(fd,"wb") as stream:
                    def write(data):
                        nonlocal count,used,truncated
                        try:
                            event=json.loads(data)
                            if event["atMs"]<since or event["eventId"] in seen:
                                return
                            if any(filters.get(key) is not None and filters[key]!=event.get(key) for key in ("requestId","component","tool","code","level","tabId","chatTabId","groupId","taskId")):
                                return
                            # Re-project even persisted records; do not trust
                            # arbitrary JSONL fields written by another process.
                            clean=safe_fields(event)
                            clean["eventId"]=event["eventId"]
                            clean["ts"]=datetime.fromtimestamp(event["atMs"]/1000,timezone.utc).isoformat()
                            encoded=(json.dumps(clean,separators=(",",":"),allow_nan=False)+"\n").encode()
                            if used+len(encoded)>limit:
                                truncated=True
                                return
                            stream.write(encoded)
                            used+=len(encoded);count+=1;seen.add(event["eventId"])
                        except (ValueError,KeyError,TypeError,OverflowError):
                            return
                    # Recent RAM events first, then recent disk segments.
                    for data in reversed(snapshot):
                        write(data)
                    for segment in reversed(self._segments()):
                        if truncated:
                            break
                        try:
                            with segment.open("rb") as source:
                                for data in source:
                                    if len(data)<=4096 and data.endswith(b"\n"):
                                        write(data)
                        except FileNotFoundError:
                            continue
                os.replace(temp,path)
                self.export_path=path
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
            return {"workspacePath":"scheduled/reliability-trace.jsonl","events":count,"sizeBytes":used,"truncated":truncated}


TRACE=Trace()


def emit(event, **fields):
    context=REQUEST.get() or {}
    TRACE.add({**context,"component":"agent","instanceId":INSTANCE,"event":event,"level":"INFO","monoMs":time.monotonic()*1000,**fields})
