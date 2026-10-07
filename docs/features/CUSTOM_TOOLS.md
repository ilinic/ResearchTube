# Custom Tools

ResearchTube can load developer-owned tools from `agent/custom-tools/`. Each
immediate subdirectory is one package. The package directory may have any
name, but it must contain a `manifest.json`.

The manifest declares a package and one or more tools. `groupTitle` names the
group shown in Extension Settings; `title` belongs to an individual tool.
Tool names are explicit and are not derived from directory or file names.

```text
agent/custom-tools/custom-toolset/
├── manifest.json
└── tools.py
```

Each tool has a lowercase `name`, a human-readable `title` and `description`,
an object `inputSchema`, and an `entryPoint` in the form
`relative/file.py:function`. The entry point must remain inside its package.
`execution` is either `sync` or `task`. A package can point several tools at
different functions in the same Python file or at separate files.

```json
{
  "manifestVersion": 1,
  "id": "example.custom-toolset",
  "version": "1.0.0",
  "groupTitle": "Custom Toolset",
  "tools": [
    {
      "name": "count_words",
      "title": "Count words",
      "description": "Count the words in supplied text.",
      "entryPoint": "tools.py:count_words",
      "execution": "sync",
      "inputSchema": {"type": "object"}
    }
  ]
}
```

The function receives `(arguments, context)` and returns a JSON object. The
context exposes the package directory, `progress(percent, message)` and
`check_cancelled()`. A synchronous function returns its result directly. A
task function returns a task record immediately; its progress, result and
cancellation use `custom_tool_status` and `custom_tool_cancel`.

Agent console logs use the manifest's exact tool name for invocation, status,
cancellation and terminal outcomes. `context.progress(percent, message)` logs
the supplied percentage for task tools, including updates between status polls.
Sync tools log their name and outcome without percentages; their context's
progress callback has no effect. Input/result payloads and progress messages
are not printed.

The bundled `custom-toolset` demonstrates both modes. `count_words` is a
small synchronous operation. `wait_seconds` is an asynchronous example that
waits for one to sixty seconds, publishes progress and responds to
cancellation. It does not require an external service or Workspace file.

The Agent reads packages at startup. A malformed package is reported in the
Custom Tools diagnostics and does not prevent other packages from loading.
After adding or changing a package, restart the Agent and refresh the
ResearchTube MCP catalog in ChatGPT. ResearchTube does not install Python
dependencies or watch the directory for changes.

Custom implementations run with the operating-system permissions of the
Local Agent. Only place trusted developer code in this directory.
