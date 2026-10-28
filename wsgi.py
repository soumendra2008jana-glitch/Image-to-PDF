"""
WebScan Production WSGI Entrypoint
Suitable for production deployment via Waitress (Windows/Linux) or Gunicorn (Linux/Container).

Usage:
    Windows / Cross-platform: python wsgi.py
    Linux / Container:        gunicorn wsgi:app -b 0.0.0.0:5000 --workers 4
"""

import os
import sys

# Ensure backend directory is in python module search path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), 'backend')))

from app import app

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    from waitress import serve
    print(f"\n=======================================================")
    print(f" WebScan Production Server Running (Waitress WSGI)")
    print(f" Desktop: http://localhost:{port}")
    print(f" Mobile (Wi-Fi): http://0.0.0.0:{port}")
    print(f" Threads: 8 | Production Mode: Active")
    print(f"=======================================================\n")
    serve(app, host='0.0.0.0', port=port, threads=8)
