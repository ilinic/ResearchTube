"""Run database regression tests in the existing release CI test discovery."""
from agent.tests.test_scheduled_memory import SharedMemoryTest  # noqa: F401
from agent.tests.test_shared_memory import CrossChatMemoryTest  # noqa: F401
from agent.tests.test_agent_plans import AgentPlanTest  # noqa: F401

from agent.tests.test_reliability import ReliabilityTraceTest  # noqa: F401
