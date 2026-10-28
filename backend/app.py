"""
WebScan Backend Flask Application
Provides API endpoints for ping health checks and PDF compilation from image streams.
Security hardened against DoS, path traversal, CRLF header injection, decompression bombs,
and unauthenticated resource abuse.
"""

import os
import sys
import re
import time
import base64
from collections import defaultdict
from threading import Lock
from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS

# Ensure backend root is always on sys.path regardless of execution CWD
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

try:
    from services.pdf_generator import create_pdf_from_images
except ImportError:
    from backend.services.pdf_generator import create_pdf_from_images

# Path to frontend directory for optional direct hosting
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))

# Use static_folder=None so all static requests pass through hardened serve_static handler
app = Flask(__name__, static_folder=None)

# 1. Security: Set maximum request payload size (50 MB) to prevent DoS while allowing multi-page scans
MAX_PAYLOAD_MB = int(os.environ.get('MAX_CONTENT_LENGTH_MB', 50))
app.config['MAX_CONTENT_LENGTH'] = MAX_PAYLOAD_MB * 1024 * 1024

# 2. Security: Configure CORS with restricted methods and configurable origins
cors_env = os.environ.get('CORS_ALLOWED_ORIGINS', '*').strip()
allowed_origins = [o.strip() for o in cors_env.split(',') if o.strip()] if cors_env != '*' else '*'
CORS(
    app,
    resources={
        r"/api/*": {"origins": allowed_origins},
        r"/ping": {"origins": allowed_origins}
    },
    methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['Content-Type', 'Authorization']
)


# 3. Security: In-memory rate limiter per IP address for expensive endpoints
class InMemoryRateLimiter:
    """Thread-safe sliding window rate limiter per client IP."""
    def __init__(self, max_requests=30, window_seconds=60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests = defaultdict(list)
        self.lock = Lock()
        self.enabled = os.environ.get('RATE_LIMIT_ENABLED', 'true').lower() in ('true', '1')

    def is_allowed(self, client_ip):
        if not self.enabled:
            return True
        now = time.time()
        with self.lock:
            cutoff = now - self.window_seconds
            self.requests[client_ip] = [ts for ts in self.requests[client_ip] if ts > cutoff]
            if len(self.requests[client_ip]) >= self.max_requests:
                return False
            self.requests[client_ip].append(now)
            return True

    def reset(self):
        with self.lock:
            self.requests.clear()


rate_limiter = InMemoryRateLimiter(
    max_requests=int(os.environ.get('RATE_LIMIT_REQUESTS', 30)),
    window_seconds=int(os.environ.get('RATE_LIMIT_WINDOW', 60))
)


def get_client_ip():
    """Extracts client IP safely considering reverse proxies."""
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr or '127.0.0.1'


def sanitize_filename(filename, max_length=80):
    """
    Sanitizes filename removing directory traversal tokens, control characters,
    quotes, and illegal characters. Prevents CRLF injection / HTTP response header splitting.
    Enforces maximum length constraint.
    """
    if not filename or not isinstance(filename, str):
        return 'Scanned_Document'

    # Strip null bytes and control chars (prevents CRLF header injection)
    clean = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', filename)
    # Remove directory traversal patterns repeatedly
    while '..' in clean:
        clean = clean.replace('..', '')
    # Strip illegal filename & header characters (slashes, colons, quotes, equals, etc.)
    clean = re.sub(r'[/\\?%*:|"<>`\';=]+', '_', clean.strip())
    # Strip leading/trailing underscores, dots, or spaces
    clean = clean.strip(' ._')
    # Enforce maximum character length
    clean = clean[:max_length].rstrip(' ._')
    return clean or 'Scanned_Document'


# 4. Security: HTTP Security Headers via after_request hook
@app.after_request
def apply_security_headers(response):
    """Injects modern HTTP security headers to protect against XSS, clickjacking, MIME sniffing."""
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://docs.opencv.org 'wasm-unsafe-eval'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "connect-src 'self' data: blob: https: http:; "
        "media-src 'self' blob:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'self'"
    )
    if request.is_secure:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    return response


# 5. Security: Error Handlers preventing stack trace / system information leaks
@app.errorhandler(413)
def handle_payload_too_large(error):
    return jsonify({
        'error': f'Request payload exceeds maximum allowed size limit of {MAX_PAYLOAD_MB} MB.'
    }), 413


@app.errorhandler(400)
def handle_bad_request(error):
    return jsonify({'error': 'Bad request.'}), 400


@app.errorhandler(404)
def handle_not_found(error):
    return jsonify({'error': 'Not found.'}), 404


@app.errorhandler(500)
def handle_internal_error(error):
    app.logger.error("Internal Server Error: %s", str(error), exc_info=True)
    return jsonify({'error': 'An internal server error occurred.'}), 500


@app.route('/ping', methods=['GET'])
def ping():
    """Health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'webscan-backend',
        'version': '1.0.0'
    }), 200


@app.route('/api/generate-pdf', methods=['POST'])
def generate_pdf_endpoint():
    """
    Compiles an array of images into a single downloadable PDF.
    Supports both multipart/form-data (recommended) and JSON with base64 data URLs.
    Includes rate limiting, file size enforcement, format validation, and safe error handling.
    """
    # Rate limit check per IP
    client_ip = get_client_ip()
    if not rate_limiter.is_allowed(client_ip):
        return jsonify({
            'error': 'Rate limit exceeded. Please wait a moment before generating another PDF.'
        }), 429

    try:
        image_items = []
        filename = 'Scanned_Document'
        page_size = 'A4'
        orientation = 'auto'

        target_size_kb = None
        target_size_val = None
        target_size_unit = 'KB'

        # 1. Check for multipart/form-data
        if request.files and 'images' in request.files:
            uploaded_files = request.files.getlist('images')
            for f in uploaded_files:
                if f.filename:
                    image_items.append(f.read())

            filename = request.form.get('filename', filename)
            page_size = request.form.get('page_size', page_size)
            orientation = request.form.get('orientation', orientation)
            target_size_val = request.form.get('target_size_value') or request.form.get('target_size_kb')
            target_size_unit = request.form.get('target_size_unit', 'KB')

        # 2. Check for JSON payload fallback
        elif request.is_json:
            data = request.get_json(silent=True) or {}
            raw_images = data.get('images', [])

            for item in raw_images:
                # Handle base64 Data URL or raw base64
                if isinstance(item, str):
                    if ',' in item:
                        item = item.split(',', 1)[1]
                    try:
                        decoded = base64.b64decode(item, validate=True)
                        image_items.append(decoded)
                    except Exception:
                        return jsonify({'error': 'Invalid base64 encoding in image payload.'}), 400

            filename = data.get('filename', filename)
            page_size = data.get('page_size', page_size)
            orientation = data.get('orientation', orientation)
            target_size_val = data.get('target_size_value') or data.get('target_size_kb')
            target_size_unit = data.get('target_size_unit', 'KB')

        # Calculate target size in KB if specified
        if target_size_val:
            try:
                val = float(target_size_val)
                if val > 0:
                    if str(target_size_unit).strip().upper() == 'MB':
                        target_size_kb = int(val * 1024)
                    else:
                        target_size_kb = int(val)
            except (ValueError, TypeError):
                target_size_kb = None

        # Validation
        if not image_items:
            return jsonify({
                'error': 'No images provided. Send files via form-data under key "images" or JSON array.'
            }), 400

        clean_filename = sanitize_filename(filename)

        # Compile PDF in-memory using img2pdf service with security limits
        pdf_buffer = create_pdf_from_images(
            image_list=image_items,
            page_size=page_size,
            orientation=orientation,
            target_size_kb=target_size_kb
        )

        return send_file(
            pdf_buffer,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f"{clean_filename}.pdf"
        )

    except ValueError as ve:
        # Controlled client validation error
        return jsonify({'error': str(ve)}), 400
    except Exception as e:
        # Log internal detail on server, but do not leak system internals/paths to client
        app.logger.error("Error compiling PDF: %s", str(e), exc_info=True)
        return jsonify({'error': 'Failed to compile PDF document due to an internal server error.'}), 500


# 6. Security: Hardened static file serving protecting against directory traversal & info disclosure
@app.route('/')
def serve_index():
    index_path = os.path.join(FRONTEND_DIR, 'index.html')
    if os.path.exists(index_path):
        return send_from_directory(FRONTEND_DIR, 'index.html')
    return jsonify({'status': 'WebScan API is running.'}), 200


@app.route('/favicon.ico')
def serve_favicon():
    favicon_path = os.path.join(FRONTEND_DIR, 'favicon.ico')
    if os.path.exists(favicon_path):
        return send_from_directory(FRONTEND_DIR, 'favicon.ico', mimetype='image/vnd.microsoft.icon')
    return ('', 204)


@app.route('/<path:path>')
def serve_static(path):
    # Reject directory traversal tokens or null bytes
    if '..' in path or '\0' in path:
        return jsonify({'error': 'Forbidden'}), 403

    normalized_path = os.path.normpath(path)
    # Reject dotfiles (e.g. .env, .git)
    parts = normalized_path.split(os.sep)
    for part in parts:
        if part.startswith('.'):
            return jsonify({'error': 'Forbidden'}), 403

    # Reject dangerous file types from being served
    blocked_extensions = ('.pem', '.key', '.crt', '.env', '.py', '.pyc', '.md', '.log', '.json')
    if any(normalized_path.lower().endswith(ext) for ext in blocked_extensions):
        return jsonify({'error': 'Forbidden'}), 403

    # Ensure the target canonical path is strictly inside FRONTEND_DIR
    target_abs = os.path.realpath(os.path.join(FRONTEND_DIR, normalized_path))
    frontend_real = os.path.realpath(FRONTEND_DIR)
    if not target_abs.startswith(frontend_real + os.sep) and target_abs != frontend_real:
        return jsonify({'error': 'Forbidden'}), 403

    if os.path.isfile(target_abs):
        safe_rel_path = normalized_path.replace('\\', '/')
        return send_from_directory(FRONTEND_DIR, safe_rel_path)

    return jsonify({'error': 'Not found'}), 404


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    use_ssl = '--ssl' in sys.argv or os.environ.get('USE_SSL', 'false').lower() in ('true', '1')
    is_dev = '--dev' in sys.argv or os.environ.get('FLASK_ENV', '').lower() == 'development'

    cert_path = os.path.join(BACKEND_DIR, 'cert.pem')
    key_path = os.path.join(BACKEND_DIR, 'key.pem')
    ssl_context = None

    if use_ssl and os.path.exists(cert_path) and os.path.exists(key_path):
        ssl_context = (cert_path, key_path)
        print(f"\n=======================================================")
        print(f" WebScan Backend Running with HTTPS (Secure Context)")
        print(f" Desktop: https://localhost:{port}")
        print(f" Mobile (Wi-Fi): https://<your-machine-ip>:{port}")
        print(f"=======================================================\n")
        app.run(host='0.0.0.0', port=port, ssl_context=ssl_context, debug=False)
    elif not is_dev:
        try:
            from waitress import serve
            print(f"\n=======================================================")
            print(f" WebScan Production Server Running (Waitress WSGI)")
            print(f" Desktop: http://localhost:{port}")
            print(f" Mobile (Wi-Fi): http://0.0.0.0:{port}")
            print(f" Threads: 8 | Production Mode: Active")
            print(f"=======================================================\n")
            serve(app, host='0.0.0.0', port=port, threads=8)
        except ImportError:
            app.run(host='0.0.0.0', port=port, debug=False)
    else:
        app.run(host='0.0.0.0', port=port, debug=False)
