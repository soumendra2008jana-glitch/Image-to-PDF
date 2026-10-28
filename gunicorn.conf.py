import os

# Render dynamically injects the $PORT environment variable
port = os.environ.get("PORT", "5000")
bind = f"0.0.0.0:{port}"

# Optimize concurrency for Render Free/Starter tiers (typically 512MB RAM)
workers = int(os.environ.get("WEB_CONCURRENCY", 2))
threads = 4
worker_class = "gthread"
timeout = 120  # Prevent premature worker timeouts during large multi-page PDF generation
keepalive = 5

accesslog = "-"
errorlog = "-"
loglevel = "info"
