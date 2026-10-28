# Frontend Product Requirements Document (PRD) & Architecture

## 1. Overview
The WebScan frontend delivers a client-side document scanning, edge-detection, perspective rectification, and image enhancement pipeline. By executing all image transformations in the user's browser, the application provides real-time visual feedback, maintains document privacy, and operates efficiently on mobile and desktop devices.

The UI follows a **clean, professional green and white design system** (`#16a34a` primary emerald, `#ffffff` card surfaces, `#f8fafc` slate background, and `#0f172a` high-contrast typography). It avoids heavy glassmorphism, distracting glow effects, and unsolicited startup popups.

## 2. Technical Stack & UI Design
* **Core:** HTML5, Modern Vanilla CSS3, Vanilla JavaScript (ES6+ modular architecture).
* **Computer Vision & Graphics:**
  * `OpenCV.js` (v4.8.0 WebAssembly): Powers multi-pass document contour analysis, 4-point perspective warping (`cv.warpPerspective`), adaptive Gaussian thresholding, and unsharp masking.
  * `Canvas 2D Context API`: Offscreen preset caching, 256-entry Uint8ClampedArray Lookup Table (LUT) pixel manipulation, and zero-dependency fallback document edge/content scanning.
* **Vector Icons:** `Lucide Icons` (clean, lightweight UI icons).
* **Responsive Layout:** CSS Flexbox/Grid, dynamic viewport units (`100dvh`), iOS safe-area insets (`env(safe-area-inset-*)`).

---

## 3. Core Features & Requirements

### REQ-F1: Dual-Tier Camera & Capture Pipeline
* **Live WebRTC Viewfinder:**
  * Uses `navigator.mediaDevices.getUserMedia` with ultra-high-definition constraints (`width: { ideal: 3840, min: 1280 }, height: { ideal: 2160, min: 720 }`) to capture the maximum native resolution from 4K/1080p sensors.
  * Supports rear/front camera switching and hardware torch/flashlight toggle.
* **Direct Native System Camera Fallback:**
  * Uses `<input type="file" accept="image/*" capture="environment">` to automatically launch the device's native camera app when accessed over plain HTTP LAN Wi-Fi IPs where browsers restrict WebRTC to Secure Contexts (`isSecureContext`).
* **Error Guidance:** Classifies hardware and permission errors (`NotAllowedError`, `NotFoundError`, `NotReadableError`) and provides troubleshooting tips.

### REQ-F2: Local File Ingestion & Drag-and-Drop
* Provides an interactive drag-and-drop dropzone and file browser supporting single or multi-file image ingestion (JPG, PNG, WEBP).
* Batch Queue: Multiple files are queued and processed sequentially through crop and filter screens.

### REQ-F3: Intelligent Multi-Strategy Auto-Cropping & Content Detection
Eliminates arbitrary static cropping boxes by implementing a hierarchical detection pipeline in `cropper_utils.js`:
* **Strategy A: OpenCV Document Boundary Quad Detection (Paper on Desk/Surface)**:
  * Downscales source canvas to a normalized working resolution (`maxDim = 640`) for resolution-invariant thresholds and execution (< 30ms).
  * Computes dynamic Canny thresholds based on image mean luminance (`mean * 0.38`, `mean * 1.25`).
  * Applies morphological closing (`5x5` kernel) to seal paper boundary breaks caused by glare, staples, shadows, or creases.
  * Combines Canny with Otsu binarization and morphological gradient to detect light paper against darker backgrounds and vice versa.
  * Computes convex hull (`cv.convexHull`) to eliminate finger occlusions, staples, and paper folds.
  * Evaluates multi-epsilon polygon approximations (`[0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06]`) with internal angle geometry validation (45°–135°).
  * Uses `cv.minAreaRect` fallback for curved or rounded document corners, deriving 4 oriented corners mathematically.
* **Strategy B: OpenCV Salient Content Detection (Important Part of Document)**:
  * For close-up captures or flatbed scans where paper fills the frame (> 90%) or desk contrast is low.
  * Computes Sobel gradient magnitude (X and Y), applies Otsu thresholding, and runs horizontal morphological clustering (`kw=11..22`, `kh=3..9`) to group text lines, tables, headers, and form fields into cohesive content blocks.
  * Calculates the bounding envelope of all content blocks and adds a 4% margin so text is not clipped.
  * **"Crop Content" Button ([`#btn-detect-content`](file:///d:/Backup/Soumendra%20Jana/Vibe%20Projects/PDF%20Scanner/frontend/index.html#L152)):** Allows users to explicitly snap the crop box to the important text/table content.
* **Strategy C: Pure Canvas 2D Instant Scanner**:
  * Pure Canvas 2D luminance variance scanner running in < 5ms without external libraries.
  * Ensures users immediately receive an intelligent, content-aware crop box even while OpenCV.js is still downloading.
* **Asynchronous OpenCV Readiness Hook**:
  * Automatically detects when OpenCV WebAssembly finishes initializing; automatically upgrades the crop corners if the user has not manually adjusted handles yet (`!userHasManuallyAdjusted`).
* **Deterministic Point Ordering:**
  * Sorts the 4 points by X-coordinate into left and right pairs, then sorts each pair by Y to cleanly identify `TL`, `BL`, `TR`, `BR`. Validated with vector cross-product winding direction and polar angle centroid fallback for heavy perspective tilts.

### REQ-F4: Manual 4-Corner Quad Transform & Precision Magnifying Loupe
* **Touch Handles:** 4 corner pins with expanded 64px touch targets and haptic vibration feedback (`navigator.vibrate(15)`).
* **Magnifying Loupe Lens:** 2x circular crosshair zoom showing sub-pixel placement under the user's finger. Automatically flips below the handle when dragged near the top of the viewport.
* **Bicubic Perspective Warping:** Computes transformation matrix (`cv.getPerspectiveTransform`) and applies `cv.warpPerspective` with **Bicubic Interpolation (`cv.INTER_CUBIC`)** rather than bilinear, preserving micro-contrast, sharp typographic edges, and eliminating blur.

### REQ-F5: Smooth Real-Time Document Filtering & Maximum-Fidelity Enhancement
* **Filter Presets:**
  * *Original:* 100% bit-for-bit lossless source document.
  * *B&W Document:* Background illumination whitening via morphological lighting estimation and normalization (`cv.divide(gray, bg, norm, 255)`), blended with moderate adaptive thresholding (`C=5`) to produce crisp, solid black text on pure white paper without breaking character strokes or causing jagged 1-bit pixelation.
  * *Magic Color:* Illumination-normalized color enhancement with subtle unsharp masking (`amount = 1.25, radius = 1.2`) that whitens paper while preserving 100% natural color fidelity, hue ratios, stamps, and signatures with zero HSV quantization banding.
  * *Grayscale:* Balanced luminance conversion with contrast preservation.
* **Two-Tier Offscreen Preset Caching:** Heavy OpenCV filters only execute when switching filter presets, caching the result in an offscreen `presetCanvas`.
* **256-Entry Uint8ClampedArray Lookup Table (LUT):** Real-time brightness (-100 to 100) and contrast (-100 to 100) adjustments precompute a 256-byte transformation table and apply direct pixel memory mapping in < 2ms.
* **Canvas2D `{ willReadFrequently: true }` Attribute:** Pre-configures all interactive and fallback canvas contexts with `willReadFrequently: true`, eliminating GPU readback performance penalties and browser console warnings during slider adjustments and image binarization.
* **`requestAnimationFrame` Frame Coalescing:** Eliminates slider lag by syncing slider updates with the browser's refresh rate (60/120fps).
* **Export Quality:** Exports pages at high-fidelity `0.98` JPEG quality (or lossless PNG for B&W documents), eliminating visible compression degradation.

### REQ-F6: Multi-Page Gallery & Document Management
* Maintains an array of processed page images (Blobs + DataURLs).
* Thumbnail preview grid with page badges, reordering (move left / move right), and page deletion.

### REQ-F7: PDF Export & Adaptive Size Control
* Export settings modal:
  * Filename input with automated sanitization.
  * Page formats: `A4`, `US_Letter`, `Fit`.
  * Layout orientation: `auto`, `portrait`, `landscape`.
  * Target PDF file size controls: `Max (Original Quality)`, `200 KB`, `500 KB`, `1 MB`, `2 MB`, or custom size input.
* Dispatches `multipart/form-data` to `/api/generate-pdf` and triggers automatic client-side download of the returned binary stream.

### REQ-F8: Security & DOM Protection
* Content Security Policy (CSP) meta tags and backend headers restricting script, style, and connect origins while specifying `'unsafe-eval'`, `'wasm-unsafe-eval'`, and `connect-src 'self' data: blob: https: http:` to permit Emscripten WebAssembly binary instantiation via `data:` URLs.
* User Activation Guarding: Interactive file input dialogs and native mobile camera triggers respect browser user activation lifecycle requirements without synthetic dispatch errors.
* Safe DOM insertion: Avoids `innerHTML` injection with user-supplied data; uses `textContent` in toasts and modal labels.
* Parameter sanitization in `api.js` for safe HTTP request construction.

### REQ-F9: Mobile Responsiveness & Touch UX
* Mobile-first responsive styling with notch safe-area support (`env(safe-area-inset-*)`).
* Inputs styled with minimum 16px font to prevent unwanted iOS Safari auto-zooming.
* Tactile shutter animations and clear feedback toasts.

---

## 4. Frontend File Architecture
```text
/frontend
│
├── index.html                 # Main markup (Capture screen, Crop screen, Filter screen, Gallery modal)
├── style.css                  # Professional Green & White design system (Tokens, layouts, handles, cards)
│
└── /js
    ├── app.js                 # Application orchestrator, screen router, event wiring, toast system
    ├── camera.js              # WebRTC controller, native camera fallback, torch toggle, frame capture
    ├── cropper_utils.js       # Multi-strategy auto-crop, salient content detection, 4-corner handles, loupe, warp
    ├── filter_utils.js        # Offscreen preset cache, 256-entry LUT brightness/contrast, OpenCV filters
    └── api.js                 # API communication, parameter sanitation, PDF download handler
```

---

## 5. Verification & Testing
1. **Headless Browser CDP Testing (`test_browser_cropper.py`):** Runs automated browser tests validating `cropperManager.autoDetectCorners()`, `detectSalientContent()`, and `warpDocument()`.
2. **DOM Selector Validation (`validate_frontend.py`):** Verifies that all element IDs referenced across JavaScript files match corresponding HTML elements in `index.html`.
3. **Full Workflow Test (`test_full_workflow.py`):** Verifies end-to-end integration from camera frame capture to multi-page PDF generation.