"""Manifest-based Custom Tools for the ResearchTube Local Agent.

Each direct child of ``custom-tools`` is a package.  A package contains a
manifest.json and may expose several Python entry points.  This module keeps
the manifest boundary deliberately small: package metadata is read at Agent
startup, while implementations are loaded only when a tool is invoked.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any, Callable


NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
PACKAGE_ID_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,119}$")
ENTRY_POINT_RE = re.compile(r"^([A-Za-z0-9_./-]+\.py):([A-Za-z_][A-Za-z0-9_]*)$")
MAX_MANIFEST_BYTES = 512 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024


class CustomToolError(Exception):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error(error_type: type[Exception], code: str, message: str, detail: str | None = None) -> Exception:
    return error_type(code, message, detail)


def _is_json_value(value: Any) -> bool:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return False
    return len(encoded.encode("utf-8")) <= MAX_RESULT_BYTES


@dataclass(frozen=True)
class CustomToolSpec:
    package_id: str
    package_dir: Path
    group_title: str
    package_version: str
    name: str
    title: str
    description: str
    entry_point: str
    execution: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None

    def mcp_definition(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "_meta": {
                "researchtube/customTool": {
                    "packageId": self.package_id,
                    "groupTitle": self.group_title,
                    "execution": self.execution,
                }
            },
        }
        if self.output_schema is not None:
            result["outputSchema"] = self.output_schema
        return result


@dataclass
class CustomTask:
    task_id: str
    spec: CustomToolSpec
    created_at: str
    last_updated_at: str
    status: str = "working"
    phase: str = "running"
    progress_percent: float = 0
    status_message: str = "Custom tool is running."
    result: Any = None
    error: dict[str, str] | None = None
    runner: asyncio.Task[Any] | None = field(default=None, repr=False)

    def document(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "tool": self.spec.name,
            "status": self.status,
            "phase": self.phase,
            "progressPercent": self.progress_percent,
            "statusMessage": self.status_message,
            "createdAt": self.created_at,
            "lastUpdatedAt": self.last_updated_at,
            "pollIntervalMs": 1000,
            "result": self.result,
            "error": self.error,
        }


class CustomToolContext:
    def __init__(self, package_dir: Path, task: CustomTask | None = None) -> None:
        self.package_dir = package_dir
        self._task = task

    def progress(self, percent: int | float, message: str) -> None:
        if self._task is None:
            return
        if isinstance(percent, bool) or not isinstance(percent, (int, float)) or not 0 <= percent <= 100:
            raise CustomToolError("CUSTOM_TOOL_PROGRESS_INVALID", "Custom tool progress must be between 0 and 100.")
        if not isinstance(message, str) or not message.strip() or len(message) > 240:
            raise CustomToolError("CUSTOM_TOOL_PROGRESS_INVALID", "Custom tool progress message is invalid.")
        self._task.progress_percent = float(percent)
        self._task.status_message = message.strip()
        self._task.last_updated_at = utc_now()

    def check_cancelled(self) -> None:
        if self._task is not None and self._task.status == "cancelled":
            raise asyncio.CancelledError


class CustomToolRegistry:
    def __init__(self, root: Path, error_type: type[Exception], history_limit: Callable[[], int] | None = None) -> None:
        self.root = root
        self.error_type = error_type
        self.history_limit = history_limit or (lambda: 2000)
        self.tools: dict[str, CustomToolSpec] = {}
        self.errors: list[dict[str, str]] = []
        self.modules: dict[Path, ModuleType] = {}
        self.tasks: dict[str, CustomTask] = {}
        self.reload()

    def prune(self) -> None:
        try:
            limit = max(1, int(self.history_limit()))
        except (TypeError, ValueError):
            limit = 2000
        terminal = [task for task in self.tasks.values() if task.status in {"completed", "failed", "cancelled"}]
        if len(terminal) <= limit:
            return
        terminal.sort(key=lambda task: task.last_updated_at)
        for task in terminal[:-limit]:
            self.tasks.pop(task.task_id, None)

    def _raise(self, code: str, message: str, detail: str | None = None) -> None:
        raise _error(self.error_type, code, message, detail)

    def reload(self) -> None:
        self.tools.clear()
        self.errors.clear()
        self.modules.clear()
        if not self.root.is_dir():
            return
        for package_dir in sorted(self.root.iterdir(), key=lambda item: item.name.casefold()):
            if not package_dir.is_dir() or package_dir.name.startswith("."):
                continue
            try:
                self._load_package(package_dir)
            except Exception as error:
                code = getattr(error, "code", "CUSTOM_TOOL_PACKAGE_INVALID")
                message = getattr(error, "message", str(error))
                self.errors.append({"package": package_dir.name, "code": code, "message": message})

    def _load_package(self, package_dir: Path) -> None:
        manifest_path = package_dir / "manifest.json"
        if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "Custom tool package must contain a small manifest.json.")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "Custom tool manifest is not valid UTF-8 JSON.", str(error))
        if not isinstance(manifest, dict) or manifest.get("manifestVersion") != 1:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "manifestVersion must be 1.")
        package_id = manifest.get("id")
        group_title = manifest.get("groupTitle")
        version = manifest.get("version")
        tools = manifest.get("tools")
        if not isinstance(package_id, str) or not PACKAGE_ID_RE.fullmatch(package_id):
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "id must be a lowercase package identifier.")
        if not isinstance(group_title, str) or not group_title.strip() or len(group_title) > 120:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "groupTitle must be a non-empty string of at most 120 characters.")
        if not isinstance(version, str) or not version.strip() or len(version) > 40:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "version must be a non-empty string of at most 40 characters.")
        if not isinstance(tools, list) or not tools:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "tools must be a non-empty array.")
        for item in tools:
            self._load_tool(package_id, package_dir, group_title.strip(), version.strip(), item)

    def _load_tool(self, package_id: str, package_dir: Path, group_title: str, version: str, item: Any) -> None:
        if not isinstance(item, dict):
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "Each tools entry must be an object.")
        name, title, description = item.get("name"), item.get("title"), item.get("description")
        entry_point, execution, input_schema = item.get("entryPoint"), item.get("execution", "sync"), item.get("inputSchema")
        output_schema = item.get("outputSchema")
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", "Tool names must match lowercase snake_case.")
        if name in self.tools:
            self._raise("CUSTOM_TOOL_NAME_CONFLICT", f"Custom tool name '{name}' is already registered.")
        if not isinstance(title, str) or not title.strip() or len(title) > 160:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' has an invalid title.")
        if not isinstance(description, str) or not description.strip() or len(description) > 4000:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' has an invalid description.")
        if not isinstance(entry_point, str) or not ENTRY_POINT_RE.fullmatch(entry_point):
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' has an invalid entryPoint.")
        if execution not in {"sync", "task"}:
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' execution must be sync or task.")
        if not isinstance(input_schema, dict) or input_schema.get("type") != "object":
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' inputSchema must be an object schema.")
        if output_schema is not None and not isinstance(output_schema, dict):
            self._raise("CUSTOM_TOOL_MANIFEST_INVALID", f"Tool '{name}' outputSchema must be an object.")
        relative_file = Path(entry_point.split(":", 1)[0])
        source = (package_dir / relative_file).resolve()
        if not source.is_file() or not source.is_relative_to(package_dir.resolve()):
            self._raise("CUSTOM_TOOL_ENTRYPOINT_INVALID", f"Tool '{name}' entryPoint is outside its package or missing.")
        self.tools[name] = CustomToolSpec(package_id, package_dir, group_title, version, name, title.strip(), description.strip(), entry_point, execution, input_schema, output_schema)

    def catalog(self) -> dict[str, Any]:
        return {
            "tools": [spec.mcp_definition() for spec in self.tools.values()],
            "errors": list(self.errors),
        }

    def get(self, name: str) -> CustomToolSpec:
        spec = self.tools.get(name)
        if spec is None:
            self._raise("CUSTOM_TOOL_NOT_FOUND", "The requested custom tool is not available.")
        return spec

    def _function(self, spec: CustomToolSpec) -> Callable[..., Any]:
        module_path_text, function_name = spec.entry_point.split(":", 1)
        module_path = (spec.package_dir / module_path_text).resolve()
        module = self.modules.get(module_path)
        if module is None:
            module_name = f"researchtube_custom_{secrets.token_hex(8)}"
            module_spec = importlib.util.spec_from_file_location(module_name, module_path)
            if module_spec is None or module_spec.loader is None:
                self._raise("CUSTOM_TOOL_ENTRYPOINT_INVALID", f"Could not load '{spec.name}'.")
            module = importlib.util.module_from_spec(module_spec)
            sys.modules[module_name] = module
            try:
                module_spec.loader.exec_module(module)
            except Exception as error:
                sys.modules.pop(module_name, None)
                self._raise("CUSTOM_TOOL_LOAD_FAILED", f"Could not load custom tool '{spec.name}'.", str(error))
            self.modules[module_path] = module
        function = getattr(module, function_name, None)
        if not callable(function):
            self._raise("CUSTOM_TOOL_ENTRYPOINT_INVALID", f"Entry point for '{spec.name}' is not callable.")
        return function

    async def _invoke(self, spec: CustomToolSpec, arguments: dict[str, Any], context: CustomToolContext) -> Any:
        function = self._function(spec)
        try:
            value = function(arguments, context)
            if inspect.isawaitable(value):
                value = await value
        except asyncio.CancelledError:
            raise
        except CustomToolError:
            raise
        except Exception as error:
            self._raise("CUSTOM_TOOL_EXECUTION_FAILED", f"Custom tool '{spec.name}' failed.", str(error))
        if not isinstance(value, dict) or not _is_json_value(value):
            self._raise("CUSTOM_TOOL_RESULT_INVALID", f"Custom tool '{spec.name}' must return a JSON object within the result limit.")
        return value

    def _validate_arguments(self, spec: CustomToolSpec, arguments: dict[str, Any]) -> None:
        properties = spec.input_schema.get("properties", {})
        required = spec.input_schema.get("required", [])
        if not isinstance(properties, dict) or not isinstance(required, list):
            self._raise("CUSTOM_TOOL_SCHEMA_INVALID", f"Custom tool '{spec.name}' has an invalid input schema.")
        missing = [name for name in required if name not in arguments]
        if missing:
            self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' requires: {', '.join(missing)}.")
        if spec.input_schema.get("additionalProperties") is False:
            unknown = sorted(set(arguments) - set(properties))
            if unknown:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' received unsupported arguments: {', '.join(unknown)}.")
        for name, schema in properties.items():
            if name not in arguments or not isinstance(schema, dict):
                continue
            value, expected = arguments[name], schema.get("type")
            valid = {
                "string": isinstance(value, str), "integer": isinstance(value, int) and not isinstance(value, bool),
                "number": isinstance(value, (int, float)) and not isinstance(value, bool), "boolean": isinstance(value, bool),
                "array": isinstance(value, list), "object": isinstance(value, dict),
            }.get(expected, True)
            if not valid:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' argument '{name}' has the wrong type.")
            if isinstance(value, (str, list, dict)) and isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' argument '{name}' is too short.")
            if isinstance(value, (str, list, dict)) and isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' argument '{name}' is too long.")
            if isinstance(value, (int, float)) and isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' argument '{name}' is below its minimum.")
            if isinstance(value, (int, float)) and isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
                self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", f"Custom tool '{spec.name}' argument '{name}' is above its maximum.")

    async def call(self, name: str, arguments: Any) -> dict[str, Any]:
        self.prune()
        spec = self.get(name)
        if not isinstance(arguments, dict):
            self._raise("CUSTOM_TOOL_ARGUMENTS_INVALID", "Custom tool arguments must be an object.")
        self._validate_arguments(spec, arguments)
        if spec.execution == "sync":
            return {"kind": "result", "tool": name, "result": await self._invoke(spec, arguments, CustomToolContext(spec.package_dir))}
        now = utc_now()
        task_id = f"ct_{secrets.token_urlsafe(8)}"
        task = CustomTask(task_id, spec, now, now)
        self.tasks[task_id] = task
        task.runner = asyncio.create_task(self._run_task(task, arguments), name=f"researchtube-custom-{task_id}")
        return {"kind": "task", "task": task.document()}

    async def _run_task(self, task: CustomTask, arguments: dict[str, Any]) -> None:
        try:
            task.result = await self._invoke(task.spec, arguments, CustomToolContext(task.spec.package_dir, task))
            task.status, task.phase, task.progress_percent = "completed", "completed", 100
            task.status_message, task.last_updated_at = "Custom tool completed.", utc_now()
        except asyncio.CancelledError:
            task.status, task.phase = "cancelled", "cancelled"
            task.status_message, task.last_updated_at = "Custom tool cancelled.", utc_now()
        except Exception as error:
            task.status, task.phase = "failed", "failed"
            task.error = {"code": getattr(error, "code", "CUSTOM_TOOL_EXECUTION_FAILED"), "message": getattr(error, "message", str(error))}
            task.status_message, task.last_updated_at = "Custom tool failed.", utc_now()

    def status(self, task_id: str) -> dict[str, Any]:
        self.prune()
        task = self.tasks.get(task_id)
        if task is None:
            self._raise("CUSTOM_TOOL_TASK_NOT_FOUND", "The requested custom tool task does not exist.")
        return task.document()

    async def cancel(self, task_id: str) -> dict[str, Any]:
        self.prune()
        task = self.tasks.get(task_id)
        if task is None:
            self._raise("CUSTOM_TOOL_TASK_NOT_FOUND", "The requested custom tool task does not exist.")
        if task.status in {"completed", "failed", "cancelled"}:
            return task.document()
        task.status, task.phase = "cancelled", "cancelled"
        if task.runner is not None:
            task.runner.cancel()
        task.status_message, task.last_updated_at = "Custom tool cancellation accepted.", utc_now()
        return task.document()

    async def shutdown(self) -> None:
        for task in self.tasks.values():
            if task.runner is not None and not task.runner.done():
                task.runner.cancel()
        if self.tasks:
            await asyncio.gather(*(task.runner for task in self.tasks.values() if task.runner is not None), return_exceptions=True)
