"""Run database regression tests in the existing release CI test discovery."""
from agent.tests.test_scheduled_memory import SharedMemoryTest  # noqa: F401
from agent.tests.test_shared_memory import CrossChatMemoryTest  # noqa: F401
