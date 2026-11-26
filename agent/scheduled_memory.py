"""Bounded, isolated shared memory for ResearchTube agents."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import random
import re
import json
import math
import os
import sqlite3
import tempfile
import threading
import time
import uuid

try:
    from .reliability import emit
except ImportError:
    from reliability import emit

try:
    from . import agent_plans
except ImportError:
    import agent_plans

MAX_TEXT_BYTES = 32768
MAX_SQL_BYTES = 32768
MAX_STATEMENTS = 40
MAX_ROWS = 200
MAX_RESPONSE_BYTES = 256 * 1024
DB_FILE = "scheduled/database.sqlite"
_LOCK = threading.RLock()
_DB_LOCK = threading.Lock()
_OPERATION = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_DEDUP_TABLE = "_rt_internal_operations"
_DEDUP_LIMIT = 64 * 1024 * 1024
_DEDUP_COUNT = 100000
MEMORY_PREFIX = "-- RT_SHARED_MEMORY_V1\n"
MEMORY_CONTENT_BYTES = 16 * 1024
MEMORY_RESPONSE_BYTES = 128 * 1024


class SqlQueue:
    """FIFO admission on the Agent event loop, not thousands of blocked threads."""
    def __init__(self, capacity=4096, wait_seconds=12):
        self.capacity = capacity
        self.wait_seconds = wait_seconds
        self.lock = asyncio.Lock()
        self.depth = 0

    async def run(self, resolve, arguments, name):
        if name not in ("db_outbox_submit","db_outbox_status","db_outbox_list","db_outbox_ack","__outbox_process","__memory_submit","__plan_submit"):
            fail("INVALID_ARGUMENT","Only outbox operations enter the write queue.")
        if self.depth >= self.capacity:
            fail("DB_QUEUE_FULL", "SQL queue is full; no SQL executed.")
        self.depth += 1
        started = time.monotonic()
        emit("SQL_QUEUED", queueDepth=self.depth)
        try:
            try:
                await asyncio.wait_for(self.lock.acquire(), self.wait_seconds)
            except asyncio.TimeoutError:
                fail("DB_QUEUE_TIMEOUT", "SQL queue deadline reached; no SQL executed.")
            try:
                emit("SQL_QUEUE_ACQUIRED", queueDepth=self.depth, durationMs=(time.monotonic()-started)*1000)
                task = asyncio.create_task(asyncio.to_thread(call, resolve, name, arguments))
                try:
                    return await asyncio.shield(task)
                except asyncio.CancelledError:
                    # A cancelled HTTP caller cannot cancel a running SQLite thread.
                    # Hold admission until its outcome has been recorded.
                    try:
                        await task
                    except Exception:
                        pass
                    raise
            finally:
                self.lock.release()
        finally:
            self.depth -= 1


class ReadQueue:
    """Bounded parallel read-only requests; never acquire the write queue."""
    def __init__(self, concurrency=8, capacity=256):
        self.slots=asyncio.Semaphore(concurrency)
        self.capacity=capacity
        self.depth=0

    async def run(self, resolve, arguments, name="db_query"):
        if name not in ("db_query","memory_read","__memory_status","__plan_status") and name not in agent_plans.READS|agent_plans.PRIVATE_READS:
            fail("INVALID_ARGUMENT","Invalid read operation.")
        if self.depth>=self.capacity:
            fail("DB_READ_QUEUE_FULL","Read queue full; retry later.")
        self.depth+=1
        try:
            try:
                await asyncio.wait_for(self.slots.acquire(),8)
            except asyncio.TimeoutError:
                fail("DB_READ_QUEUE_TIMEOUT","Read queue deadline reached.")
            try:
                task=asyncio.create_task(asyncio.to_thread(call,resolve,name,arguments))
                try:
                    return await asyncio.shield(task)
                except asyncio.CancelledError:
                    try:
                        await task
                    except Exception:
                        pass
                    raise
            finally:
                self.slots.release()
        finally:
            self.depth-=1


class MemoryOperationError(Exception):
    def __init__(self, code, message, state="not_started", sqlite_code=None, sqlite_name=None, index=None):
        super().__init__(message)
        self.code, self.executionState = code, state
        self.sqlite_code, self.sqlite_name, self.index = sqlite_code, sqlite_name, index


def fail(code, message):
    raise MemoryOperationError(code, message)


def check_file(path):
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        fail("WORKSPACE_PATH_INVALID", "Memory path must be a regular unlinked file.")


def connect(resolve, read_only=False):
    if not read_only:
        resolve("scheduled").mkdir(exist_ok=True)
    path = resolve(DB_FILE)
    for suffix in ("", "-wal", "-shm", "-journal"):
        check_file(resolve(DB_FILE + suffix))
    connection = sqlite3.connect(path.resolve().as_uri()+"?mode=ro" if read_only else path, uri=read_only, timeout=0.5, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout=500")
        if read_only:
            connection.execute("PRAGMA query_only=ON")
        else:
            connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        # Bound database growth from untrusted agent-generated SQL.
        if not read_only:
            connection.execute("PRAGMA max_page_count=262144")
            if connection.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal" and connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
                fail("DB_SQL_ERROR", "Could not enable WAL.")
        if hasattr(connection, "enable_load_extension"):
            connection.enable_load_extension(False)
        if hasattr(connection, "setlimit"):
            for name, limit in (("SQLITE_LIMIT_LENGTH", 1048576), ("SQLITE_LIMIT_SQL_LENGTH", MAX_SQL_BYTES),
                                ("SQLITE_LIMIT_ATTACHED", 0), ("SQLITE_LIMIT_COLUMN", 256),
                                ("SQLITE_LIMIT_EXPR_DEPTH", 100), ("SQLITE_LIMIT_COMPOUND_SELECT", 30)):
                if hasattr(sqlite3, name):
                    connection.setlimit(getattr(sqlite3, name), limit)
        return connection
    except BaseException:
        connection.close()
        raise


def ensure_dedup(connection):
    connection.execute("CREATE TABLE IF NOT EXISTS _rt_internal_operations (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS _rt_internal_outbox (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sql TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, code TEXT)")


def ensure_shared_memory(connection):
    connection.execute("""CREATE TABLE IF NOT EXISTS shared_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        topic TEXT NOT NULL DEFAULT '',
        source_chat TEXT,
        content TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_shared_memory_topic_id ON shared_memory(topic,id)")


def initialize(resolve):
    with _DB_LOCK:
        con = connect(resolve)
        try:
            ensure_dedup(con)
            ensure_shared_memory(con)
            agent_plans.ensure(con)
        finally:
            con.close()


_ALLOWED = {getattr(sqlite3, "SQLITE_" + name) for name in (
    "SELECT", "READ", "INSERT", "UPDATE", "DELETE", "CREATE_INDEX", "CREATE_TABLE",
    "CREATE_TRIGGER", "CREATE_VIEW", "DROP_INDEX", "DROP_TABLE", "DROP_TRIGGER",
    "DROP_VIEW", "ALTER_TABLE", "REINDEX", "ANALYZE", "FUNCTION", "RECURSIVE"
) if hasattr(sqlite3, "SQLITE_" + name)}
_PRAGMAS = {"table_info", "table_xinfo", "table_list", "index_info", "index_xinfo",
            "index_list", "foreign_key_list", "foreign_key_check"}
_FUNCTIONS = set("""abs avg changes char coalesce concat concat_ws count date datetime format glob group_concat
hex ifnull iif instr julianday last_insert_rowid length like likelihood likely lower ltrim max min nullif
octet_length printf quote random randomblob replace round rtrim sign soundex strftime substr substring
sum time timediff total total_changes trim typeof unicode unixepoch unlikely unhex upper zeroblob
sqlite_version sqlite_source_id sqlite_compileoption_get sqlite_compileoption_used sqlite_rename_table sqlite_rename_test sqlite_rename_column sqlite_drop_column sqlite_rename_quotefix
row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
json json_array json_array_length json_error_position json_extract json_insert json_object json_patch
json_quote json_remove json_replace json_set json_type json_valid json_group_array json_group_object
jsonb jsonb_array jsonb_extract jsonb_insert jsonb_object jsonb_patch jsonb_remove jsonb_replace jsonb_set
jsonb_group_array jsonb_group_object -> ->> ceil ceiling floor exp ln log log10 log2 mod pi pow power sqrt
sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh atanh degrees radians trunc""".split())


def authorize(action, a, b, database, source):
    if any(isinstance(name, str) and (name.lower().startswith("_rt_internal_") or name.lower() in ("shared_memory","idx_shared_memory_topic_id")) for name in (a, b, source)):
        return sqlite3.SQLITE_DENY
    if database == "temp" and a == "sqlite_temp_master" and action in (sqlite3.SQLITE_READ, sqlite3.SQLITE_UPDATE):
        return sqlite3.SQLITE_OK
    if database not in (None, "main"):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA:
        return sqlite3.SQLITE_OK if (a or "").lower() in _PRAGMAS else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION:
        return sqlite3.SQLITE_OK if (b or "").lower() in _FUNCTIONS else sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK if action in _ALLOWED else sqlite3.SQLITE_DENY


def statements(sql):
    if not isinstance(sql, str) or not sql.strip() or len(sql.encode("utf-8")) > MAX_SQL_BYTES:
        fail("DB_SQL_INVALID", "Provide nonempty SQL up to 32 KiB.")
    result, start = [], 0
    for index, char in enumerate(sql):
        if char == ";" and sqlite3.complete_statement(sql[start:index + 1]):
            result.append(sql[start:index + 1])
            start = index + 1
            if len(result) > MAX_STATEMENTS:
                fail("DB_SQL_INVALID", "Too many SQL statements.")
    if sql[start:].strip():
        result.append(sql[start:])
    if not result or len(result) > MAX_STATEMENTS:
        fail("DB_SQL_INVALID", "Provide 1–40 SQL statements.")
    return result


def cell(value):
    if isinstance(value, bytes):
        return "base64:" + base64.b64encode(value).decode("ascii")
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


_READ_ACTIONS={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_PRAGMA}
if hasattr(sqlite3,"SQLITE_RECURSIVE"):
    _READ_ACTIONS.add(sqlite3.SQLITE_RECURSIVE)


def authorize_read(action,a,b,database,source):
    if action not in _READ_ACTIONS:
        return sqlite3.SQLITE_DENY
    return authorize(action,a,b,database,source)


def db_query(resolve,sql):
    parts=statements(sql)
    connection=None
    started=time.monotonic()
    deadline=started+8
    results=[]
    used=0
    index=None
    try:
        connection=connect(resolve,read_only=True)
        connection.set_progress_handler(lambda:int(time.monotonic()>=deadline),1000)
        # One consistent snapshot across a batch, no write reservation.
        connection.execute("BEGIN")
        connection.set_authorizer(authorize_read)
        emit("SQL_READ_STARTED",statementCount=len(parts))
        for index,statement in enumerate(parts):
            if time.monotonic()>=deadline:
                fail("DB_SQL_TIMEOUT","Read execution exceeded its time budget.")
            cursor=connection.execute(statement)
            columns=[column[0] for column in cursor.description or ()]
            entry={"columns":columns,"rows":[],"rowsAffected":0,"truncated":False}
            used+=len(json.dumps(columns,ensure_ascii=False).encode("utf-8"))+100
            if used>MAX_RESPONSE_BYTES:
                fail("DB_SQL_LIMIT","Read result metadata exceeds the response budget.")
            for raw in cursor:
                if time.monotonic()>=deadline:
                    fail("DB_SQL_TIMEOUT","Read execution exceeded its time budget.")
                if len(entry["rows"])>=MAX_ROWS:
                    entry["truncated"]=True
                    break
                row=[cell(value) for value in raw]
                size=len(json.dumps(row,ensure_ascii=False,allow_nan=False).encode("utf-8"))+1
                if used+size>MAX_RESPONSE_BYTES:
                    entry["truncated"]=True
                    break
                entry["rows"].append(row)
                used+=size
            cursor.close()
            results.append(entry)
        emit("SQL_READ_COMPLETED",statementCount=len(parts),durationMs=(time.monotonic()-started)*1000)
        return {"success":True,"results":results,"truncated":any(r["truncated"] for r in results)}
    except sqlite3.Error as error:
        raw=getattr(error,"sqlite_errorcode",None)
        name=getattr(error,"sqlite_errorname","SQLITE_ERROR")
        primary=raw&255 if isinstance(raw,int) else None
        code={sqlite3.SQLITE_AUTH:"DB_READ_ONLY",sqlite3.SQLITE_READONLY:"DB_READ_ONLY",sqlite3.SQLITE_BUSY:"DB_BUSY",sqlite3.SQLITE_LOCKED:"DB_LOCKED"}.get(primary,"DB_SQL_TIMEOUT" if time.monotonic()>=deadline else "DB_SQL_ERROR")
        emit("SQL_READ_FAILED",level="ERROR",code=code,sqliteCode=raw,sqliteName=name,statementIndex=index)
        message="Only read-only SQL is accepted; use db_outbox_submit for changes." if code=="DB_READ_ONLY" else "Read failed: "+name
        raise MemoryOperationError(code,message,"not_started",raw,name,index) from error
    finally:
        if connection is not None:
            connection.set_authorizer(None)
            connection.set_progress_handler(None,0)
            connection.close()


def _execute_write(resolve, sql, operation_id):
    memory = decode_memory(sql) if sql.startswith(MEMORY_PREFIX) else None
    planned = agent_plans.decode(sql) if sql.startswith(agent_plans.PREFIX) else None
    parts = [] if memory is not None or planned is not None else statements(sql)
    operation_key(operation_id)
    # Direct Python callers and the Agent's FIFO queue share this guard.
    with _DB_LOCK:
        deadline = time.monotonic() + 8
        for attempt in range(1, 5):
            try:
                return _transaction(resolve, sql, parts, operation_id, deadline, attempt, memory, planned)
            except MemoryOperationError as error:
                if error.code not in ("DB_BUSY", "DB_LOCKED") or error.executionState not in ("not_started", "rolled_back"):
                    raise
                if attempt == 4:
                    emit("RETRY_EXHAUSTED",level="ERROR",attempt=attempt,code=error.code,executionState=error.executionState)
                    raise
                delay = .25 * 2 ** (attempt - 1) * random.uniform(.85, 1.15)
                if time.monotonic() + delay >= deadline:
                    raise
                emit("RETRY_SCHEDULED", attempt=attempt+1, code=error.code, durationMs=delay*1000)
                time.sleep(delay)
                emit("RETRY_STARTED", attempt=attempt+1)


def _transaction(resolve, sql, parts, operation_id, deadline, attempt, memory=None, planned=None):
    connection = None
    index = None
    stage = "connect"
    started = time.monotonic()
    results, used = [], 0
    try:
        connection = connect(resolve)
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        connection.execute("BEGIN IMMEDIATE")
        stage = "transaction"
        emit("SQL_TRANSACTION_STARTED", attempt=attempt, statementCount=len(parts))
        # All production writes are keyed durable outbox jobs.
        ensure_dedup(connection)
        if operation_id is not None:
            fingerprint = hashlib.sha256(sql.encode("utf-8")).hexdigest()
            reserved = connection.execute("SELECT fingerprint FROM _rt_internal_outbox WHERE operation_id=?", (operation_id,)).fetchone()
            if reserved and reserved[0] != fingerprint:
                fail("DB_OPERATION_CONFLICT", "operationId belongs to a different outbox payload.")
            previous = connection.execute("SELECT fingerprint,result FROM _rt_internal_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    fail("DB_OPERATION_CONFLICT", "operationId already belongs to another SQL payload.")
                connection.execute("UPDATE _rt_internal_outbox SET state=\'committed\',code=NULL WHERE operation_id=?", (operation_id,))
                stage = "commit"
                connection.execute("COMMIT")
                stage = "committed"
                emit("SQL_DEDUP_HIT", attempt=attempt, executionState="committed")
                return json.loads(previous[1])
            count, size = connection.execute("SELECT count(*),coalesce(sum(length(CAST(result AS BLOB))+length(operation_id)+length(fingerprint)+128),0) FROM _rt_internal_operations").fetchone()
            if count >= _DEDUP_COUNT or size + MAX_RESPONSE_BYTES + 1024 > _DEDUP_LIMIT:
                fail("DB_DEDUP_FULL", "Operation ledger is full; no SQL executed. Do not remove keys without reconciliation.")
        if memory is not None:
            ensure_shared_memory(connection)
            topic,source,content=memory
            before=connection.total_changes
            connection.execute("INSERT INTO shared_memory(topic,source_chat,content,operation_id) VALUES (?,?,?,?) ON CONFLICT(operation_id) DO NOTHING",(topic,source,content,operation_id))
            row=connection.execute("SELECT id,created_at,topic,source_chat,content FROM shared_memory WHERE operation_id=?",(operation_id,)).fetchone()
            if not row or tuple(row[2:])!=(topic,source,content):
                fail("DB_OPERATION_CONFLICT","Operation key already belongs to different memory data.")
            results.append({"columns":["id","created_at"],"rows":[list(row[:2])],"rowsAffected":connection.total_changes-before,"truncated":False})
        if planned is not None:
            name, arguments = planned
            value=agent_plans.mutate(connection,name,arguments,operation_id)
            results.append({"columns":["data"],"rows":[[json.dumps(value,ensure_ascii=False,separators=(",",":"))]],"rowsAffected":0,"truncated":False})
        connection.set_authorizer(authorize)
        for index, statement in enumerate(parts):
            statement_started = time.monotonic()
            if time.monotonic() >= deadline:
                fail("DB_SQL_TIMEOUT", "SQL execution exceeded its time budget.")
            before = connection.total_changes
            cursor = connection.execute(statement)
            columns = [column[0] for column in cursor.description or ()]
            entry = {"columns": columns, "rows": [], "rowsAffected": 0, "truncated": False}
            used += len(json.dumps(columns, ensure_ascii=False).encode("utf-8")) + 100
            if used > MAX_RESPONSE_BYTES:
                fail("DB_SQL_LIMIT", "SQL result metadata exceeds the response budget.")
            if cursor.description:
                for raw in cursor:
                    if time.monotonic() >= deadline:
                        fail("DB_SQL_TIMEOUT", "SQL execution exceeded its time budget.")
                    if entry["truncated"] or len(entry["rows"]) >= MAX_ROWS:
                        entry["truncated"] = True
                        continue
                    row = [cell(value) for value in raw]
                    size = len(json.dumps(row, ensure_ascii=False, allow_nan=False).encode("utf-8")) + 1
                    if used + size > MAX_RESPONSE_BYTES:
                        entry["truncated"] = True
                        continue
                    entry["rows"].append(row)
                    used += size
            entry["rowsAffected"] = connection.total_changes - before
            results.append(entry)
            emit("SQL_STATEMENT_FINISHED", attempt=attempt, statementIndex=index, rowsAffected=entry["rowsAffected"], durationMs=(time.monotonic()-statement_started)*1000)
        connection.set_authorizer(None)
        result = {"success": True, "results": results, "truncated": any(r["truncated"] for r in results)}
        if operation_id is not None:
            encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > MAX_RESPONSE_BYTES + 1024:
                fail("DB_SQL_LIMIT", "SQL result exceeds the operation ledger budget.")
            connection.execute("INSERT INTO _rt_internal_operations VALUES (?,?,?,?)", (operation_id, fingerprint, encoded, int(time.time())))
        stage = "commit"
        if operation_id is not None:
            if memory is not None or planned is not None:
                connection.execute("DELETE FROM _rt_internal_outbox WHERE operation_id=?", (operation_id,))
            else:
                connection.execute("UPDATE _rt_internal_outbox SET state=\'committed\',code=NULL WHERE operation_id=?", (operation_id,))
        connection.execute("COMMIT")
        stage = "committed"
        emit("SQL_COMMITTED", attempt=attempt, executionState="committed", statementCount=len(parts), rowsAffected=sum(r["rowsAffected"] for r in results), durationMs=(time.monotonic()-started)*1000)
        return result
    except (sqlite3.Error, MemoryOperationError) as error:
        state = "not_started" if stage == "connect" else "committed" if stage == "committed" else "unknown"
        if connection is not None:
            connection.set_authorizer(None)
            connection.set_progress_handler(None, 0)
            if connection.in_transaction:
                try:
                    connection.rollback()
                    state = "rolled_back"
                except sqlite3.Error:
                    state = "unknown"
            elif stage == "transaction":
                state = "rolled_back"  # e.g. INSERT OR ROLLBACK
        if isinstance(error, MemoryOperationError):
            code, message = error.code, str(error)
            sqlite_code = sqlite_name = None
        else:
            sqlite_code = getattr(error, "sqlite_errorcode", None)
            sqlite_name = getattr(error, "sqlite_errorname", "SQLITE_ERROR")
            primary = sqlite_code & 255 if isinstance(sqlite_code, int) else None
            code = {sqlite3.SQLITE_BUSY: "DB_BUSY", sqlite3.SQLITE_LOCKED: "DB_LOCKED"}.get(primary, "DB_SQL_TIMEOUT" if time.monotonic() >= deadline else "DB_SQL_ERROR")
            message = f"SQL {state}: {sqlite_name}" + (f" at statement {index+1}" if index is not None else "")
        emit("SQL_ROLLED_BACK" if state == "rolled_back" else "SQL_FAILED", level="ERROR", attempt=attempt, code=code, executionState=state, sqliteCode=sqlite_code, sqliteName=sqlite_name, statementIndex=index, durationMs=(time.monotonic()-started)*1000)
        raise MemoryOperationError(code, message, state, sqlite_code, sqlite_name, index) from error
    finally:
        if connection is not None:
            connection.set_authorizer(None)
            connection.set_progress_handler(None, 0)
            if connection.in_transaction:
                try:
                    connection.rollback()
                except sqlite3.Error:
                    pass
            connection.close()


def text_path(resolve, logical):
    if not isinstance(logical, str) or logical.lower().startswith("scheduled/database.sqlite") or logical.lower()=="scheduled/reliability-trace.jsonl":
        fail("WORKSPACE_PATH_INVALID", "Database files must be accessed through db_query or the outbox.")
    path = resolve(logical)
    check_file(path)
    return path


def read_text(resolve, logical):
    with _LOCK:
        path = text_path(resolve, logical)
        try:
            with path.open("rb") as stream:
                data = stream.read(MAX_TEXT_BYTES + 1)
            if len(data) > MAX_TEXT_BYTES:
                fail("WORKSPACE_TEXT_TOO_LARGE", "Text file exceeds 32 KiB.")
            return {"workspacePath": logical, "text": data.decode("utf-8"), "sizeBytes": len(data)}
        except FileNotFoundError:
            fail("FILE_NOT_FOUND", "Text file does not exist.")
        except UnicodeError:
            fail("WORKSPACE_TEXT_INVALID", "File is not UTF-8.")


def write_text(resolve, logical, text):
    if not isinstance(text, str):
        fail("WORKSPACE_TEXT_INVALID", "text must be UTF-8 text.")
    data = text.encode("utf-8")
    if len(data) > MAX_TEXT_BYTES:
        fail("WORKSPACE_TEXT_TOO_LARGE", "Text exceeds 32 KiB.")
    with _LOCK:
        path = text_path(resolve, logical)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".rt-text-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, text_path(resolve, logical))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {"workspacePath": logical, "sizeBytes": len(data)}


OUTBOX_BYTES = 64 * 1024 * 1024
OUTBOX_COUNT = 10000


def operation_key(value):
    if not isinstance(value,str) or not _OPERATION.fullmatch(value):
        fail("DB_SQL_INVALID","A stable operationId is required.")
    return value


def _outbox_transaction(resolve, work):
    # One owner for all internal database operations. Never hold the lock over
    # browser/network work. The outbox is in the same DB, not in the trace.
    with _DB_LOCK:
        con = None
        try:
            con = connect(resolve)
            con.execute("BEGIN IMMEDIATE")
            ensure_dedup(con)
            ensure_shared_memory(con)
            result = work(con)
            con.commit()
            return result
        except sqlite3.Error as error:
            raw=getattr(error,"sqlite_errorcode",None)
            kind=raw&255 if isinstance(raw,int) else None
            code={sqlite3.SQLITE_BUSY:"DB_BUSY",sqlite3.SQLITE_LOCKED:"DB_LOCKED"}.get(kind,"DB_OUTBOX_ERROR")
            state="unknown"
            if con is not None and con.in_transaction:
                try:
                    con.rollback()
                    state="rolled_back"
                except sqlite3.Error:
                    pass
            raise MemoryOperationError(code,"Outbox transaction failed: "+getattr(error,"sqlite_errorname","SQLITE_ERROR"),state,raw,getattr(error,"sqlite_errorname",None)) from error
        finally:
            if con is not None:
                con.close()


def _outbox_state(con,key):
    row=con.execute("SELECT state,created_at,attempts,code FROM _rt_internal_outbox WHERE operation_id=?",(key,)).fetchone()
    committed=con.execute("SELECT created_at FROM _rt_internal_operations WHERE operation_id=?",(key,)).fetchone()
    if committed:
        return {"operationId":key,"state":"committed","createdAt":row[1] if row else committed[0],"attempts":row[2] if row else 0,"code":None,"acknowledged":row is None}
    if row:
        return {"operationId":key,"state":row[0],"createdAt":row[1],"attempts":row[2],"code":row[3],"acknowledged":False}
    return {"operationId":key,"state":"not_found","createdAt":None,"attempts":0,"code":None,"acknowledged":False}


def outbox_submit(resolve,key,sql,*,internal_memory=False,internal_plan=False):
    key=operation_key(key)
    if internal_memory:
        decode_memory(sql)
    elif internal_plan:
        agent_plans.decode(sql)
    else:
        if isinstance(sql,str) and sql.startswith((MEMORY_PREFIX,agent_plans.PREFIX)):
            fail("DB_SQL_INVALID","Internal memory payloads require memory_append.")
        statements(sql)  # Validate size and statement count before durable admission.
    digest=hashlib.sha256(sql.encode("utf-8")).hexdigest()
    def submit(con):
        for table in ("_rt_internal_operations","_rt_internal_outbox"):
            old=con.execute("SELECT fingerprint FROM "+table+" WHERE operation_id=?",(key,)).fetchone()
            if old and old[0]!=digest:
                fail("DB_OPERATION_CONFLICT","operationId already belongs to another SQL payload.")
        current=_outbox_state(con,key)
        if current["state"]!="not_found":
            return current
        count,size=con.execute("SELECT count(*),coalesce(sum(length(CAST(sql AS BLOB))+length(operation_id)+256),0) FROM _rt_internal_outbox").fetchone()
        if count>=OUTBOX_COUNT or size+len(sql.encode("utf-8"))+512>OUTBOX_BYTES:
            fail("DB_OUTBOX_FULL","Outbox is full. No package accepted; preserve your original data.")
        con.execute("INSERT INTO _rt_internal_outbox(operation_id,fingerprint,sql,created_at,state) VALUES(?,?,?,?,?)",(key,digest,sql,int(time.time()),"pending"))
        return _outbox_state(con,key)
    value=_outbox_transaction(resolve,submit)
    emit("OUTBOX_ACCEPTED",status=value["state"])
    return value


def outbox_status(resolve,key):
    return _outbox_transaction(resolve,lambda con:_outbox_state(con,operation_key(key)))


def outbox_list(resolve,limit=50,offset=0):
    if type(limit) is not int or not 1<=limit<=100 or type(offset) is not int or not 0<=offset<=OUTBOX_COUNT:
        fail("INVALID_ARGUMENT","Invalid outbox page.")
    def list_items(con):
        rows=con.execute("SELECT operation_id FROM _rt_internal_outbox ORDER BY created_at,operation_id LIMIT ? OFFSET ?",(limit+1,offset)).fetchall()
        return {"items":[_outbox_state(con,row[0]) for row in rows[:limit]],"nextOffset":offset+limit if len(rows)>limit else None}
    return _outbox_transaction(resolve,list_items)


def outbox_ack(resolve,key):
    key=operation_key(key)
    def ack(con):
        state=_outbox_state(con,key)
        if state["state"]!="committed":
            fail("DB_OUTBOX_NOT_COMMITTED","Cannot acknowledge an uncommitted package.")
        con.execute("DELETE FROM _rt_internal_outbox WHERE operation_id=?",(key,))
        return _outbox_state(con,key)
    return _outbox_transaction(resolve,ack)


def outbox_claim(resolve):
    def claim(con):
        # After a crash, processing is unknown; check the ledger before retry.
        row=con.execute("SELECT operation_id,sql,attempts FROM _rt_internal_outbox WHERE state IN ('pending','processing','unknown') AND next_at<=? ORDER BY next_at,created_at,operation_id LIMIT 1",(int(time.time()),)).fetchone()
        if not row:
            return None
        key,sql,attempts=row
        if _outbox_state(con,key)["state"]=="committed":
            con.execute("UPDATE _rt_internal_outbox SET state='committed',code=NULL WHERE operation_id=?",(key,))
            return None
        con.execute("UPDATE _rt_internal_outbox SET state='processing',attempts=attempts+1 WHERE operation_id=?",(key,))
        return {"operationId":key,"sql":sql,"attempts":attempts+1}
    return _outbox_transaction(resolve,claim)


def outbox_failure(resolve,job,error):
    key=job["operationId"]
    code=getattr(error,"code","DB_OUTBOX_ERROR")
    raw=getattr(error,"sqlite_code",None)
    primary=raw&255 if isinstance(raw,int) else None
    permanent=code in ("DB_OPERATION_CONFLICT","DB_SQL_INVALID","DB_SQL_LIMIT","MEMORY_INVALID","PLAN_INVALID","PLAN_CONFLICT") or primary in (sqlite3.SQLITE_ERROR,sqlite3.SQLITE_CONSTRAINT,sqlite3.SQLITE_AUTH,sqlite3.SQLITE_MISMATCH,sqlite3.SQLITE_RANGE,sqlite3.SQLITE_TOOBIG)
    def update(con):
        state=_outbox_state(con,key)
        if state["state"]=="committed":
            return state
        next_state="failed_permanent" if permanent else "unknown" if getattr(error,"executionState","unknown")=="unknown" else "pending"
        delay=min(300,5*2**min(job["attempts"]-1,6))
        con.execute("UPDATE _rt_internal_outbox SET state=?,code=?,next_at=? WHERE operation_id=?",(next_state,code,int(time.time())+delay,key))
        return _outbox_state(con,key)
    return _outbox_transaction(resolve,update)


def outbox_process_one(resolve):
    job=outbox_claim(resolve)
    if job is None:
        return False
    emit("OUTBOX_PROCESSING",attempt=job["attempts"],operationId=job["operationId"],tool="memory_append" if job["sql"].startswith(MEMORY_PREFIX) else "db_outbox_submit")
    try:
        _execute_write(resolve,job["sql"],job["operationId"])
        emit("OUTBOX_COMMITTED",executionState="committed",operationId=job["operationId"],tool="memory_append" if job["sql"].startswith(MEMORY_PREFIX) else "db_outbox_submit")
    except (MemoryOperationError,OSError) as error:
        value=outbox_failure(resolve,job,error)
        emit("OUTBOX_FAILED",level="ERROR",code=value["code"],status=value["state"],operationId=job["operationId"],tool="memory_append" if job["sql"].startswith(MEMORY_PREFIX) else "db_outbox_submit")
    return True


def memory_topic(value):
    if not isinstance(value,str) or len(value)>80:
        fail("MEMORY_INVALID","Topic must be at most 80 characters.")
    return value.strip().translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"))


def memory_payload(arguments):
    if not isinstance(arguments,dict) or set(arguments)-{"content","topic","source_chat","operation_id"}:
        fail("MEMORY_INVALID","Invalid memory arguments.")
    content=arguments.get("content")
    if not isinstance(content,str) or not content.strip():
        fail("MEMORY_INVALID","Provide nonempty content.")
    topic=memory_topic(arguments.get("topic",""))
    source=arguments.get("source_chat")
    if source is not None and (not isinstance(source,str) or not source.strip() or len(source)>1024):
        fail("MEMORY_INVALID","source_chat must be a nonempty URL or ID up to 1024 characters.")
    try:
        if len(content.encode("utf-8"))>MEMORY_CONTENT_BYTES:
            fail("MEMORY_TOO_LARGE","Content exceeds 16 KiB UTF-8. Split the entry; nothing was truncated.")
        fields=[base64.b64encode(v.encode("utf-8")).decode("ascii") if v is not None else None for v in (topic,source,content)]
        payload=MEMORY_PREFIX+json.dumps(fields,separators=(",",":"))
        if len(payload.encode("utf-8"))>MAX_SQL_BYTES:
            fail("MEMORY_TOO_LARGE","Memory payload exceeds the outbox limit.")
    except UnicodeError:
        fail("MEMORY_INVALID","Content and metadata must be valid UTF-8.")
    return payload


def decode_memory(payload):
    try:
        if not isinstance(payload,str) or not payload.startswith(MEMORY_PREFIX) or len(payload.encode("utf-8"))>MAX_SQL_BYTES:
            raise ValueError()
        fields=json.loads(payload[len(MEMORY_PREFIX):])
        if not isinstance(fields,list) or len(fields)!=3:
            raise ValueError()
        topic,source,content=[base64.b64decode(v,validate=True).decode("utf-8") if v is not None else None for v in fields]
        if memory_payload({"topic":topic,"source_chat":source,"content":content})!=payload:
            raise ValueError()
        return topic,source,content
    except (ValueError,TypeError,UnicodeError,MemoryOperationError):
        fail("MEMORY_INVALID","Invalid internal memory payload.")


def memory_submit(resolve,arguments):
    payload=memory_payload(arguments)
    key=operation_key(arguments.get("operation_id","sm."+uuid.uuid4().hex))
    state=outbox_submit(resolve,key,payload,internal_memory=True)
    emit("MEMORY_ACCEPTED",tool="memory_append",operationId=key,status=state["state"],bytes=len(arguments["content"].encode("utf-8")))
    return {"state":state["state"],"operation_id":key}


def memory_status(resolve,key):
    key=operation_key(key)
    con=None
    try:
        con=connect(resolve,read_only=True)
        con.execute("BEGIN")
        row=con.execute("SELECT id,created_at FROM shared_memory WHERE operation_id=?",(key,)).fetchone()
        if row:
            return {"state":"committed","operation_id":key,"id":row[0],"created_at":row[1]}
        state=_outbox_state(con,key)
        if state["state"]=="committed":
            fail("DB_OPERATION_CONFLICT","Operation key has no matching memory entry.")
        value={"state":"pending" if state["state"] in ("pending","processing") else state["state"],"operation_id":key}
        if state["code"]:
            value["code"]=state["code"]
        return value
    except sqlite3.Error as error:
        raise MemoryOperationError("MEMORY_READ_FAILED","Memory status could not be verified.","unknown",getattr(error,"sqlite_errorcode",None),getattr(error,"sqlite_errorname",None)) from error
    finally:
        if con is not None:
            con.close()


def memory_read(resolve,arguments):
    if not isinstance(arguments,dict) or set(arguments)-{"after_id","limit","topic","before_id"}:
        fail("MEMORY_INVALID","Invalid memory read arguments.")
    limit=arguments.get("limit",20)
    after=arguments.get("after_id")
    before=arguments.get("before_id")
    if type(limit) is not int or not 1<=limit<=100:
        fail("MEMORY_INVALID","limit must be 1–100.")
    for name,value in (("after_id",after),("before_id",before)):
        if name in arguments and (type(value) is not int or not 0<=value<=9007199254740991):
            fail("MEMORY_INVALID","Cursor must be a nonnegative safe integer.")
    if after is not None and before is not None:
        fail("MEMORY_INVALID","Choose after_id or before_id, not both.")
    clauses,params=[],[]
    for value,comparison in ((after,">"),(before,"<")):
        if value is not None:
            clauses.append("id "+comparison+" ?");params.append(value)
    if "topic" in arguments:
        clauses.append("topic = ?");params.append(memory_topic(arguments["topic"]))
    where=" WHERE "+" AND ".join(clauses) if clauses else ""
    order="ASC" if after is not None else "DESC"
    con=None
    items=[]
    used=256
    more=False
    try:
        con=connect(resolve,read_only=True)
        deadline=time.monotonic()+8
        con.set_progress_handler(lambda:int(time.monotonic()>=deadline),1000)
        cursor=con.execute("SELECT id,created_at,topic,source_chat,content FROM shared_memory"+where+" ORDER BY id "+order+" LIMIT ?",(*params,limit+1))
        for row in cursor:
            item=dict(zip(("id","created_at","topic","source_chat","content"),row))
            # Count escaped JSON conservatively for all transports.
            size=len(json.dumps(item,ensure_ascii=True).encode("utf-8"))+1
            if len(items)>=limit or used+size>MEMORY_RESPONSE_BYTES:
                if not items:
                    fail("MEMORY_TOO_LARGE","A stored entry exceeds the response budget.")
                more=True
                break
            items.append(item);used+=size
        if order=="DESC":
            items.reverse()
        return {"items":items,"next_after_id":items[-1]["id"] if items else after,"next_before_id":items[0]["id"] if items and more and order=="DESC" else None,"has_more":more}
    except sqlite3.Error as error:
        raise MemoryOperationError("MEMORY_READ_FAILED","Shared memory read failed.","not_started",getattr(error,"sqlite_errorcode",None),getattr(error,"sqlite_errorname",None)) from error
    finally:
        if con is not None:
            con.close()


def plan_read(resolve,name,arguments):
    con=connect(resolve,read_only=True)
    try:
        con.execute("BEGIN")
        return agent_plans.read(con,name,arguments)
    except sqlite3.Error as error:
        raise MemoryOperationError("PLAN_READ_FAILED","Plan or skill read failed.","not_started") from error
    finally:
        con.close()


def plan_operation_status(resolve,key):
    key=operation_key(key)
    con=connect(resolve,read_only=True)
    try:
        con.execute("BEGIN")
        state=_outbox_state(con,key)
        value={"state":"pending" if state["state"]=="processing" else state["state"],"operation_id":key}
        if state["code"]: value["code"]=state["code"]
        if state["state"]=="committed":
            row=con.execute("SELECT result FROM _rt_internal_operations WHERE operation_id=?",(key,)).fetchone()
            result=json.loads(row[0])
            if not result.get("results") or result["results"][0]["columns"]!=["data"]: fail("DB_OPERATION_CONFLICT","Operation key does not identify a plan mutation.")
            value["data"]=result["results"][0]["rows"][0][0]
        return value
    finally:
        con.close()


def call(resolve, name, arguments):
    if not isinstance(arguments, dict):
        fail("INVALID_ARGUMENT", "Expected tool argument object.")
    if name=="__plan_submit":
        key=operation_key(arguments["operation_id"])
        return outbox_submit(resolve,key,agent_plans.encode(arguments["name"],arguments["arguments"]),internal_plan=True)
    if name=="__plan_status":
        return plan_operation_status(resolve,arguments["operation_id"])
    if name in agent_plans.READS|agent_plans.PRIVATE_READS:
        return plan_read(resolve,name,arguments)
    if name=="__memory_submit":
        return memory_submit(resolve,arguments)
    if name=="__memory_status" and set(arguments)=={"operation_id"}:
        return memory_status(resolve,arguments["operation_id"])
    if name=="memory_read":
        return memory_read(resolve,arguments)
    if name == "__outbox_process" and not arguments:
        return outbox_process_one(resolve)
    if name == "db_outbox_submit" and set(arguments)=={"operationId","sql"}:
        return outbox_submit(resolve,arguments["operationId"],arguments["sql"])
    if name == "db_outbox_status" and set(arguments)=={"operationId"}:
        return outbox_status(resolve,arguments["operationId"])
    if name == "db_outbox_ack" and set(arguments)=={"operationId"}:
        return outbox_ack(resolve,arguments["operationId"])
    if name == "db_outbox_list" and set(arguments)<={"limit","offset"}:
        return outbox_list(resolve,arguments.get("limit",50),arguments.get("offset",0))
    if name == "db_query" and set(arguments)=={"sql"}:
        return db_query(resolve,arguments["sql"])
    if name == "workspace_read_text" and set(arguments) == {"workspacePath"}:
        return read_text(resolve, arguments["workspacePath"])
    if name == "workspace_write_text" and set(arguments) == {"workspacePath", "text"}:
        return write_text(resolve, arguments["workspacePath"], arguments["text"])
    fail("INVALID_ARGUMENT", "Unknown memory tool or invalid arguments.")
