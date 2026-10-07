#!/usr/bin/env python3
"""启动入口：python3 run.py [--port 8000] [--db wall.db]

环境变量：
  OWNER_TOKEN   站主令牌（默认 dev-owner-token，仅开发用）
  WALL_MODE     pre_moderation（先审后发，默认）| inbox（站主收件箱）
  WALL_SMTP_URL 配置后启用通知投递（无回执，送达状态仍为未知）
"""
import argparse

from app.server import serve

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="访客留言审核墙")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--db", default="wall.db")
    args = p.parse_args()
    serve(args.host, args.port, args.db)
