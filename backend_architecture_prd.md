# Backend Product Requirements Document (PRD) & Architecture

## 1. Overview
The WebScan backend is a lightweight, hardened Python web service. Its primary responsibilities are serving the static single-page application (HTML, CSS, JS) and providing a secure, high-throughput PDF compilation and compression API. By delegating all camera capture, document corner detection, perspective warping, and visual filtering to the client-side browser engine, the backend remains stateless, fast, and resilient.

## 2. Technical Stack
* **Language:** Python 3 (Python 3.10+)
* **Web Framework:** Flask (Serving both the REST API and the frontend assets)
* **Libraries:**
  * `Flask-CORS`: Handles Cross-Origin Resource Sharing with restricted origins and methods.
  * `img2pdf`: High-efficiency, lossless image-to-PDF compiler that preserves original image dimensions and embedded resolution.
  * `Pillow` (PIL): Image validation, metadata reading, format normalization (RGB/L), orientation handling, and adaptive compression downscaling.
  * `Werkzeug`: Secure filename utilities and request parsing.
* **Testing & Automation:** Python `unittest`, custom automated integration suites (`test_security.py`, `test_full_workflow.py`, `test_browser_cropper.py`).
* **Deployment:** `gunicorn` (production) / Flask WSGI server (local & LAN access).

## 3. Core Features & Requirements

### REQ-B1: API & Static File Endpoints
* `GET /`: Serves the primary single-page frontend application (`frontend/index.html`).
* `GET /<path:filename>`: Serves static frontend assets (`style.css`, `js/*.js`) with strict directory traversal prevention and cross-platform path normalization.
* `GET /ping`: Health check endpoint returning `{ "service": "webscan-backend", "status": "ok", "version": "1.0.0" }`.
* `POST /api/generate-pdf`: Compiles submitted images into a single multi-page PDF document.

### REQ-B2: Payload Handling & Ingestion
* **Multipart Form-Data:** Accepts an array of image files under the `images` field.
* **JSON Base64 Fallback:** Accepts JSON payloads containing an array of base64-encoded image data URLs (`images: ["data:image/jpeg;base64,..."]`).
* **Form Parameters:**
  * `filename`: Base name of the output PDF (default: `Scanned_Document`).
  * `page_size`: Target page format (`A4`, `US_Letter`, or `Fit`).
  * `orientation`: Page layout orientation (`auto`, `portrait`, `landscape`).
  * `target_size_value` & `target_size_unit`: Desired maximum PDF file size and unit (`KB` or `MB`).

### REQ-B3: PDF Compilation & Adaptive Compression Engine
* Stitches images sequentially using `img2pdf.convert()`, correctly mapping page sizes:
  * **A4:** Standard ISO 210 x 297 mm (`img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)`).
  * **US Letter:** Standard ANSI 8.5 x 11 in (`img2pdf.in_to_pt(8.5), img2pdf.in_to_pt(11)`).
  * **Fit:** Page dimensions match the native aspect ratio of each source image.
* **Adaptive Target Size Optimization:** When a target size (KB/MB) is requested, the service performs binary search / iterative JPEG compression and dimension scaling (JPEG quality 85 down to 25, resolution scaling down to 40%) so that the compiled document satisfies the target file size constraint.

### REQ-B4: High-Resolution Smartphone Photo Support & Dynamic Downscaling
* **High-Res Limit Expansion:** Sets `Image.MAX_IMAGE_PIXELS = 100_000_000` (100 MP) and `MAX_SINGLE_IMAGE_BYTES = 30 MB` to prevent false decompression bomb DOS errors on modern 24–50+ MP smartphone camera photos (e.g. 6758 x 3801 phone captures).
* **Automatic 4K UHD Downscaling:** Images exceeding 4K dimensions (`3840px` on longest edge) are automatically resampled using PIL's high-quality Lanczos filter down to 4K resolution before PDF compilation. This reduces compilation memory overhead by ~70% while preserving sharp document and text readability.

### REQ-B5: Production Security Hardening & Rate Limiting
* **Payload Size Ceiling:** Enforces `MAX_CONTENT_LENGTH = 50 * 1024 * 1024` (50 MB) at the WSGI layer to prevent memory exhaustion attacks.
* **In-Memory Rate Limiting:** Sliding-window rate limiter tracking client IP addresses (`30 requests / minute`). Exceeding requests receive `HTTP 429 Too Many Requests` with a `Retry-After` header.
* **Comprehensive Security Headers:** Injects security headers on all responses:
  * `Content-Security-Policy`: Restricts scripts, styles, fonts, and connects (`script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://docs.opencv.org 'wasm-unsafe-eval'`; `connect-src 'self' data: blob: https: http:`) to permit OpenCV.js Emscripten WebAssembly binary loading via `data:` URIs while strictly restricting object, framing, and base-uri origins.
  * `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing.
  * `X-Frame-Options: SAMEORIGIN`: Prevents clickjacking.
  * `Referrer-Policy: strict-origin-when-cross-origin`: Controls referrer leakage.
  * `Permissions-Policy: camera=(self), microphone=()`: Restricts sensitive browser APIs.
* **Path Traversal Protection:** Static file route validates resolved paths against `FRONTEND_DIR` and normalizes Windows backslashes to forward slashes.
* **CRLF & Header Injection Sanitation:** Strips `\r`, `\n`, `:`, and `=` from user-supplied filenames before constructing `Content-Disposition`.

### REQ-B6: Stateless In-Memory Architecture
* The server never writes temporary images or generated PDFs to permanent disk storage. All transformations operate in memory using `io.BytesIO` streams, which are automatically collected after the HTTP response terminates.

---

## 4. Production File Architecture
```text
/
├── wsgi.py                            # Production WSGI entrypoint (Waitress / Gunicorn)
├── .gitignore                         # Production ignore rules (bytecode, keys, logs)
├── backend_architecture_prd.md        # Backend PRD specification
├── frontend_architecture_prd.md       # Frontend PRD specification
│
├── backend
│   ├── app.py                         # Flask app, rate limiting, security headers, routes, static server
│   ├── requirements.txt               # Dependencies (Flask, Flask-CORS, img2pdf, Pillow, Waitress, Gunicorn)
│   ├── cert.pem                       # Self-signed TLS certificate (optional HTTPS mode)
│   ├── key.pem                        # Private TLS key (optional HTTPS mode)
│   │
│   └── services                       # Core business logic
│       ├── __init__.py                # Package initializer
│       └── pdf_generator.py           # img2pdf compilation, adaptive size compressor, 4K downscaler
│
└── frontend
    ├── index.html                     # Application UI structure and meta headers
    ├── style.css                      # Production responsive styling and animations
    ├── favicon.ico                    # Standard ICO favicon
    ├── favicon.svg                    # SVG scalable document scan icon
    └── js                             # Frontend client modules
        ├── api.js                     # API client communication module
        ├── app.js                     # Master application orchestrator
        ├── camera.js                  # Camera stream controller
        ├── cropper_utils.js           # Multi-strategy auto-cropper and quad warping
        └── filter_utils.js            # Image filters and LUT brightness/contrast engine
```

---

## 5. Production Deployment
The application is pre-configured for production serving with multi-threading and security hardening:

* **Windows / Cross-Platform (Waitress WSGI)**:
  ```bash
  python wsgi.py
  # or directly:
  python backend/app.py
  ```
  Runs a production multi-threaded WSGI server on port 5000 (`0.0.0.0:5000`) with 8 worker threads and zero debug mode vulnerabilities.

* **Linux / Docker Container / Render.com (Gunicorn WSGI)**:
  ```bash
  gunicorn wsgi:app
  ```
  Render automatically uses `render.yaml` or reads `gunicorn.conf.py` (which binds to `0.0.0.0:$PORT` with a 120s worker timeout).

* **Render.com Cloud Deployment**:
  - **Build Command:** `pip install -r requirements.txt`
  - **Start Command:** `gunicorn wsgi:app`
  - **Auto-detected Files:** `render.yaml`, `requirements.txt`, `runtime.txt`, `gunicorn.conf.py`.
  - **HTTPS:** Automatically provided by Render's SSL edge reverse proxy, enabling native mobile browser WebRTC camera access.

* **HTTPS Mobile Mode (LAN Testing with Live Camera Permissions)**:
  ```bash
  python backend/app.py --ssl
  ```