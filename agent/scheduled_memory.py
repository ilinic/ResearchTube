"""Bounded, isolated shared memory for ResearchTube agents."""
from __future__ import annotations

import base64
import json
import math
import os
import sqlite3
import tempfile
import threading
import time

MAX_TEXT_BYTES = 32768
MAX_SQL_BYTES = 32768
MAX_STATEMENTS = 40
MAX_ROWS = 200
MAX_RESPONSE_BYTES = 256 * 1024
DB_FILE = "scheduled/database.sqlite"
_LOCK = threading.RLock()


class MemoryOperationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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
    connection = sqlite3.connect(path, timeout=1.5, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout=1500")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        # Bound database growth from untrusted agent-generated SQL.
        connection.execute("PRAGMA max_page_count=262144")
        if connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
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


def initialize(resolve):
    with _LOCK:
        con = connect(resolve)
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


def db_sql(resolve, sql):
    parts = statements(sql)
    connection = connect(resolve)
    deadline = time.monotonic() + 5
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    results, used = [], 0
    try:
        connection.execute("BEGIN")
        connection.set_authorizer(authorize)
        for statement in parts:
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
        connection.set_authorizer(None)
        connection.execute("COMMIT")
        return {"success": True, "results": results, "truncated": any(r["truncated"] for r in results)}
    except sqlite3.Error as error:
        code = "DB_SQL_TIMEOUT" if time.monotonic() >= deadline else "DB_SQL_ERROR"
        # Don't log SQL or data; SQLite's raw message may include user data.
        fail(code, "SQL was rolled back: " + getattr(error, "sqlite_errorname", "SQLITE_ERROR"))
    finally:
        connection.set_authorizer(None)
        connection.set_progress_handler(None, 0)
        if connection.in_transaction:
            connection.rollback()
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
    if name == "db_sql" and set(arguments) == {"sql"}:
        return db_sql(resolve, arguments["sql"])
    if name == "workspace_read_text" and set(arguments) == {"workspacePath"}:
        return read_text(resolve, arguments["workspacePath"])
    if name == "workspace_write_text" and set(arguments) == {"workspacePath", "text"}:
        return write_text(resolve, arguments["workspacePath"], arguments["text"])
    fail("INVALID_ARGUMENT", "Unknown memory tool or invalid arguments.")
