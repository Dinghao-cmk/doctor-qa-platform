"""
logging_config.py - 结构化 JSON 日志 + 请求级 Tracing

功能：
1. 所有日志输出为 JSON 格式（便于 grep / ELK / Loki 采集）
2. 每条日志自动携带 request_id（贯穿 Node→Python 全链路）
3. FastAPI 中间件：从请求头提取或自动生成 X-Request-ID

使用方式：
    # main.py 顶部
    from logging_config import setup_logging, TracingMiddleware
    setup_logging()
    app.add_middleware(TracingMiddleware)

    # 任意模块
    import logging
    logger = logging.getLogger("rag.xxx")
    logger.info("消息", extra={"qc_code": "A004", "hits": 3})
"""
import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# ── 请求上下文（线程/协程安全）────────────────────────────────
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


# ── JSON 日志格式化器 ─────────────────────────────────────────
class JSONFormatter(logging.Formatter):
    """将 LogRecord 输出为单行 JSON"""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get("-"),
        }
        # 附加 extra 字段（排除标准属性）
        standard_keys = {
            "name", "msg", "args", "created", "filename", "funcName",
            "levelname", "levelno", "lineno", "module", "msecs",
            "message", "asctime", "relativeCreated", "thread", "threadName",
            "processName", "process", "exc_info", "exc_text", "stack_info",
            "taskName", "pathname",
        }
        for key, val in record.__dict__.items():
            if key not in standard_keys and not key.startswith("_"):
                log_entry[key] = val

        # 异常信息
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_entry, ensure_ascii=False, default=str)


# ── 初始化函数 ────────────────────────────────────────────────
def setup_logging(level: str = "INFO"):
    """
    配置全局日志为 JSON 格式。
    在 main.py 启动时调用一次即可。
    """
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # 清除已有 handler（避免 uvicorn 重复添加）
    root.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    root.addHandler(handler)

    # 降低第三方库噪音
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


# ── FastAPI 中间件：请求追踪 ──────────────────────────────────
class TracingMiddleware(BaseHTTPMiddleware):
    """
    为每个请求注入 request_id：
    - 优先从请求头 X-Request-ID 提取（Node 侧传入）
    - 未传则自动生成 UUID
    - 记录请求耗时
    - 响应头回传 X-Request-ID（便于前端/调用方关联）
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # 提取或生成 request_id
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        request_id_var.set(rid)

        start = time.perf_counter()
        logger = logging.getLogger("rag.access")

        try:
            response = await call_next(request)
            elapsed_ms = (time.perf_counter() - start) * 1000

            logger.info(
                f"{request.method} {request.url.path} → {response.status_code}",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "elapsed_ms": round(elapsed_ms, 1),
                },
            )
            response.headers["X-Request-ID"] = rid
            return response

        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.error(
                f"{request.method} {request.url.path} → 500 ({exc})",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": 500,
                    "elapsed_ms": round(elapsed_ms, 1),
                    "error": str(exc),
                },
                exc_info=True,
            )
            raise
