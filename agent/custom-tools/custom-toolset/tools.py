"""Implementation for the example Custom Toolset package."""

import asyncio


def count_words(arguments, context):
    text = arguments["text"]
    return {"text": text, "wordCount": len(text.split())}


async def wait_seconds(arguments, context):
    seconds = arguments["seconds"]
    for elapsed in range(seconds):
        context.check_cancelled()
        context.progress(round(elapsed * 100 / seconds), f"Waiting: {elapsed}/{seconds} seconds")
        await asyncio.sleep(1)
    context.progress(100, "Wait completed.")
    return {"waitedSeconds": seconds, "completed": True}
