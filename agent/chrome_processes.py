"""Read Chrome switches directly; return aggregate facts, never command lines."""


def chrome_process_report():
    import psutil

    running = False
    instances = enabled = unreadable = 0
    for process in psutil.process_iter(["name"]):
        if (process.info.get("name") or "").lower() != "chrome.exe":
            continue
        running = True
        try:
            arguments = process.cmdline()
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError):
            unreadable += 1
            continue
        if not arguments:
            unreadable += 1
            continue
        if any(arg == "--type" or arg.startswith("--type=") for arg in arguments[1:]):
            continue
        instances += 1
        enabled += "--silent-debugger-extension-api" in arguments[1:]
    return {"chromeRunning": running, "browserInstances": instances,
            "enabledInstances": enabled, "unreadableProcesses": unreadable}
