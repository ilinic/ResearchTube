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

try:
    from .reliability import emit
except ImportError:
    from reliability import emit

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


class SqlQueue:
    """FIFO admission on the Agent event loop, not thousands of blocked threads."""
    def __init__(self, capacity=4096, wait_seconds=12):
        self.capacity = capacity
        self.wait_seconds = wait_seconds
        self.lock = asyncio.Lock()
        self.depth = 0

    async def run(self, resolve, arguments):
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
                task = asyncio.create_task(asyncio.to_thread(call, resolve, "db_sql", arguments))
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


def connect(resolve):
    resolve("scheduled").mkdir(exist_ok=True)
    path = resolve(DB_FILE)
    for suffix in ("", "-wal", "-shm", "-journal"):
        check_file(resolve(DB_FILE + suffix))
    connection = sqlite3.connect(path, timeout=0.5, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout=500")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        # Bound database growth from untrusted agent-generated SQL.
        connection.execute("PRAGMA max_page_count=262144")
        if connection.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal" and connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
            fail("DB_SQL_ERROR", "Could not enable WAL.")
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


def initialize(resolve):
    with _DB_LOCK:
        con = connect(resolve)
        try:
            ensure_dedup(con)
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
    if any(isinstance(name, str) and name.lower().startswith("_rt_internal_") for name in (a, b, source)):
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


def db_sql(resolve, sql, operation_id=None):
    parts = statements(sql)
    if operation_id is not None and (not isinstance(operation_id, str) or not _OPERATION.fullmatch(operation_id)):
        fail("DB_SQL_INVALID", "Invalid operationId.")
    # Direct Python callers and the Agent's FIFO queue share this guard.
    with _DB_LOCK:
        deadline = time.monotonic() + 8
        for attempt in range(1, 5):
            try:
                return _transaction(resolve, sql, parts, operation_id, deadline, attempt)
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


def _transaction(resolve, sql, parts, operation_id, deadline, attempt):
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
        # Keep the internal ledger reserved even for legacy calls without keys.
        ensure_dedup(connection)
        if operation_id is not None:
            fingerprint = hashlib.sha256(sql.encode("utf-8")).hexdigest()
            previous = connection.execute("SELECT fingerprint,result FROM _rt_internal_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    fail("DB_OPERATION_CONFLICT", "operationId already belongs to another SQL payload.")
                stage = "commit"
                connection.execute("COMMIT")
                stage = "committed"
                emit("SQL_DEDUP_HIT", attempt=attempt, executionState="committed")
                return json.loads(previous[1])
            count, size = connection.execute("SELECT count(*),coalesce(sum(length(CAST(result AS BLOB))+length(operation_id)+length(fingerprint)+128),0) FROM _rt_internal_operations").fetchone()
            if count >= _DEDUP_COUNT or size + MAX_RESPONSE_BYTES + 1024 > _DEDUP_LIMIT:
                fail("DB_DEDUP_FULL", "Operation ledger is full; no SQL executed. Do not remove keys without reconciliation.")
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
    if not isinstance(logical, str) or logical.lower().startswith("scheduled/database.sqlite"):
        fail("WORKSPACE_PATH_INVALID", "Database files must be accessed through db_sql.")
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


def call(resolve, name, arguments):
    if not isinstance(arguments, dict):
        fail("INVALID_ARGUMENT", "Expected tool argument object.")
    if name == "db_sql" and set(arguments) in ({"sql"}, {"sql", "operationId"}):
        return db_sql(resolve, arguments["sql"], arguments.get("operationId"))
    if name == "workspace_read_text" and set(arguments) == {"workspacePath"}:
        return read_text(resolve, arguments["workspacePath"])
    if name == "workspace_write_text" and set(arguments) == {"workspacePath", "text"}:
        return write_text(resolve, arguments["workspacePath"], arguments["text"])
    fail("INVALID_ARGUMENT", "Unknown memory tool or invalid arguments.")
