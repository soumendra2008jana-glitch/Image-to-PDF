/**
 * WebScan - Cropper & Perspective Warp Utilities
 * Features:
 * - OpenCV.js-powered automatic document edge detection
 * - Interactive 4-corner quad adjustment with touch/mouse handles
 * - High-precision magnifying loupe lens
 * - 4-point perspective warp transformation (cv.warpPerspective)
 * - Clockwise / Counter-clockwise rotation
 */

class CropperManager {
  constructor() {
    this.sourceCanvas = null;
    this.workspaceEl = null;
    this.canvasWrapperEl = null;
    this.displayCanvas = null;
    this.svgOverlay = null;
    this.polygonEl = null;
    this.loupeEl = null;
    this.loupeCanvas = null;
    this.loupeCtx = null;

    // Handles map
    this.handles = {
      tl: null,
      tr: null,
      br: null,
      bl: null
    };

    // Normalized / actual image coordinates of the 4 points
    // Format: { tl: {x, y}, tr: {x, y}, br: {x, y}, bl: {x, y} }
    this.corners = null;
    this.activeCornerKey = null;
    this.scaleFactor = 1; // display px to native canvas px ratio
    this.displayRect = null;
    this.rotationAngle = 0; // 0, 90, 180, 270

    this.userHasManuallyAdjusted = false;
    this._openCvHookAttached = false;
    this.lastDetectionType = null;

    this.onCornerChangeCallback = null;
  }

  /**
   * Initializes the cropper workspace elements and event listeners
   */
  init(options) {
    this.displayCanvas = options.canvas;
    this.workspaceEl = options.workspace;
    this.canvasWrapperEl = options.wrapper;
    this.svgOverlay = options.svgOverlay;
    this.polygonEl = options.polygon;
    this.loupeEl = options.loupe;
    this.loupeCanvas = options.loupeCanvas;
    if (this.loupeCanvas) {
      this.loupeCtx = this.loupeCanvas.getContext('2d');
    }

    this.handles.tl = options.handles.tl;
    this.handles.tr = options.handles.tr;
    this.handles.br = options.handles.br;
    this.handles.bl = options.handles.bl;

    this.setupEventListeners();
  }

  /**
   * Loads an image or canvas into the cropper
   * @param {HTMLCanvasElement|HTMLImageElement} source
   */
  loadSource(source) {
    // Clone source to internal sourceCanvas
    this.sourceCanvas = document.createElement('canvas');
    this.sourceCanvas.width = source.width || source.naturalWidth;
    this.sourceCanvas.height = source.height || source.naturalHeight;
    const ctx = this.sourceCanvas.getContext('2d');
    ctx.drawImage(source, 0, 0);

    this.rotationAngle = 0;
    this.userHasManuallyAdjusted = false;
    this.renderDisplay();

    // Run auto-detect corners
    this.autoDetectCorners();
  }

  /**
   * Rotates source image by 90 degrees clockwise
   */
  rotateSource() {
    if (!this.sourceCanvas) return;

    const oldWidth = this.sourceCanvas.width;
    const oldHeight = this.sourceCanvas.height;

    const rotatedCanvas = document.createElement('canvas');
    rotatedCanvas.width = oldHeight;
    rotatedCanvas.height = oldWidth;

    const ctx = rotatedCanvas.getContext('2d');
    ctx.translate(oldHeight / 2, oldWidth / 2);
    ctx.rotate((90 * Math.PI) / 180);
    ctx.drawImage(this.sourceCanvas, -oldWidth / 2, -oldHeight / 2);

    this.sourceCanvas = rotatedCanvas;
    this.renderDisplay();
    this.autoDetectCorners();
  }

  /**
   * Renders the source image onto the display canvas with proper CSS scaling
   */
  renderDisplay() {
    if (!this.sourceCanvas || !this.displayCanvas) return;

    // Available workspace dimensions with safe padding
    const clientW = this.workspaceEl ? this.workspaceEl.clientWidth : 0;
    const clientH = this.workspaceEl ? this.workspaceEl.clientHeight : 0;

    const containerW = (clientW > 40)
      ? (clientW - 16)
      : Math.min(window.innerWidth - 24, 940);

    const containerH = (clientH > 40)
      ? (clientH - 16)
      : Math.min(window.innerHeight * 0.62, 620);

    const maxDisplayWidth = Math.max(180, Math.min(containerW, 940));
    const maxDisplayHeight = Math.max(220, Math.min(containerH, 620));

    const srcW = this.sourceCanvas.width;
    const srcH = this.sourceCanvas.height;

    const ratio = Math.min(maxDisplayWidth / srcW, maxDisplayHeight / srcH, 1);
    const displayW = Math.round(srcW * ratio);
    const displayH = Math.round(srcH * ratio);

    this.displayCanvas.width = displayW;
    this.displayCanvas.height = displayH;
    this.displayCanvas.style.width = `${displayW}px`;
    this.displayCanvas.style.height = `${displayH}px`;

    if (this.canvasWrapperEl) {
      this.canvasWrapperEl.style.width = `${displayW}px`;
      this.canvasWrapperEl.style.height = `${displayH}px`;
    }

    if (this.svgOverlay) {
      this.svgOverlay.setAttribute('width', displayW);
      this.svgOverlay.setAttribute('height', displayH);
      this.svgOverlay.setAttribute('viewBox', `0 0 ${displayW} ${displayH}`);
    }

    const ctx = this.displayCanvas.getContext('2d');
    ctx.drawImage(this.sourceCanvas, 0, 0, displayW, displayH);

    this.scaleFactor = srcW / displayW;
    this.updateDisplayMetrics();
  }

  /**
   * Updates display boundaries and syncs handle positions
   */
  updateDisplayMetrics() {
    if (!this.displayCanvas) return;
    this.displayRect = this.displayCanvas.getBoundingClientRect();
    if (this.corners) {
      this.syncHandlesToCorners();
    }
  }

  /**
   * Auto-detects 4 document corners using intelligent multi-strategy detection:
   * 1. Multi-pass OpenCV document boundary detection (Adaptive Canny + Otsu gradient)
   * 2. OpenCV salient content & text block detection (when document fills frame)
   * 3. Instant Canvas 2D luminance & variance scanner (when OpenCV is downloading or fallback)
   * @param {string|null} [forceType] Optional override: 'document' or 'content'
   * @returns {{corners: Object, type: string}}
   */
  autoDetectCorners(forceType = null) {
    if (!this.sourceCanvas) return null;

    let result = null;

    // Direct content request
    if (forceType === 'content') {
      result = this.detectSalientContent();
    } else {
      // 1. Try OpenCV detection if WebAssembly module is ready
      if (window.cv && window.cv.Mat && (window.isOpenCvReady || typeof window.cv.imread === 'function')) {
        try {
          result = this.runOpenCvDetection(this.sourceCanvas);
        } catch (err) {
          console.warn('OpenCV document detection error, trying Canvas 2D fallback:', err);
        }
      }

      // 2. If OpenCV is not ready or failed to find quad, use instant Canvas 2D detector
      if (!result) {
        result = this.detectWithCanvas2D(this.sourceCanvas);
      }
    }

    // Attach hook for when OpenCV finishes async loading to upgrade quality if unedited
    this.hookOpenCvReady();

    if (result && result.corners) {
      this.corners = result.corners;
      this.lastDetectionType = result.type;
      this.syncHandlesToCorners();
      return result;
    }

    // 3. Fallback: Adaptive 4% inset
    this.resetToAdaptiveInset();
    this.lastDetectionType = 'fallback';
    return { corners: this.corners, type: 'fallback' };
  }

  /**
   * Targets and crops specifically to the salient document content (text, tables, figures)
   * @returns {{corners: Object, type: string}|null}
   */
  detectSalientContent() {
    if (!this.sourceCanvas) return null;

    if (window.cv && window.cv.Mat && (window.isOpenCvReady || typeof window.cv.imread === 'function')) {
      let src = null, resized = null, gray = null;
      try {
        const cv = window.cv;
        src = cv.imread(this.sourceCanvas);
        const srcW = src.cols;
        const srcH = src.rows;
        const maxDim = 640;
        const scale = Math.max(srcW, srcH) / maxDim;
        const downW = Math.max(10, Math.round(srcW / scale));
        const downH = Math.max(10, Math.round(srcH / scale));

        resized = new cv.Mat();
        cv.resize(src, resized, new cv.Size(downW, downH), 0, 0, cv.INTER_AREA);

        gray = new cv.Mat();
        cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);

        const contentQuad = this.detectSalientContentOpenCv(gray, downW, downH, scale, srcW, srcH);
        if (contentQuad) {
          this.corners = contentQuad;
          this.lastDetectionType = 'content';
          this.syncHandlesToCorners();
          return { corners: contentQuad, type: 'content' };
        }
      } catch (err) {
        console.warn('OpenCV salient content detection error:', err);
      } finally {
        if (src) src.delete();
        if (resized) resized.delete();
        if (gray) gray.delete();
      }
    }

    // Fall back to Canvas 2D
    const canvasResult = this.detectWithCanvas2D(this.sourceCanvas);
    if (canvasResult && canvasResult.corners) {
      this.corners = canvasResult.corners;
      this.lastDetectionType = 'content';
      this.syncHandlesToCorners();
      return canvasResult;
    }

    this.resetToAdaptiveInset();
    return { corners: this.corners, type: 'fallback' };
  }

  /**
   * Runs OpenCV contour and salient content analysis
   * @param {HTMLCanvasElement} canvas
   * @returns {{corners: Object, type: string}|null}
   */
  runOpenCvDetection(canvas) {
    const cv = window.cv;
    let src = null;
    let resized = null;
    let gray = null;
    let blurred = null;
    let edges = null;
    let otsu = null;
    let otsuEdges = null;
    let closeKernel = null;
    let gradKernel = null;
    let contours = null;
    let hierarchy = null;
    let otsuContours = null;
    let otsuHierarchy = null;

    try {
      src = cv.imread(canvas);
      const srcW = src.cols;
      const srcH = src.rows;
      if (srcW <= 10 || srcH <= 10) return null;

      // Normalize analysis resolution for resolution-invariant thresholds & < 35ms execution
      const maxDim = 640;
      const scale = Math.max(srcW, srcH) / maxDim;
      const downW = Math.max(10, Math.round(srcW / scale));
      const downH = Math.max(10, Math.round(srcH / scale));

      resized = new cv.Mat();
      cv.resize(src, resized, new cv.Size(downW, downH), 0, 0, cv.INTER_AREA);

      gray = new cv.Mat();
      cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);

      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      const totalArea = downW * downH;

      // Pass 1: Adaptive Canny based on image luminance mean
      const meanVal = cv.mean(blurred)[0];
      const lowerCanny = Math.max(15, Math.round(meanVal * 0.38));
      const upperCanny = Math.min(235, Math.round(meanVal * 1.25));

      edges = new cv.Mat();
      cv.Canny(blurred, edges, lowerCanny, upperCanny);

      // Morphological close with 5x5 kernel to seal paper border gaps
      closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeKernel);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      // Pass 2: Otsu binarization with morphological gradient (distinguishes paper from desk)
      otsu = new cv.Mat();
      cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      gradKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      otsuEdges = new cv.Mat();
      cv.morphologyEx(otsu, otsuEdges, cv.MORPH_GRADIENT, gradKernel);

      otsuContours = new cv.MatVector();
      otsuHierarchy = new cv.Mat();
      cv.findContours(otsuEdges, otsuContours, otsuHierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      let bestQuad = null;
      let bestScore = 0;

      const evaluateContours = (cntVector) => {
        for (let i = 0; i < cntVector.size(); ++i) {
          const cnt = cntVector.get(i);
          const area = cv.contourArea(cnt);

          // Document sheet must occupy between 8% and 94% of the image
          if (area > totalArea * 0.08 && area < totalArea * 0.94) {
            const hull = new cv.Mat();
            cv.convexHull(cnt, hull, false, true);
            const peri = cv.arcLength(hull, true);

            let foundQuad = null;

            // Progressive epsilon search from tight to forgiving
            const epsilons = [0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06];
            for (let e = 0; e < epsilons.length; e++) {
              const approx = new cv.Mat();
              cv.approxPolyDP(hull, approx, epsilons[e] * peri, true);
              if (approx.rows === 4 && cv.isContourConvex(approx)) {
                const pts = [];
                for (let j = 0; j < 4; j++) {
                  pts.push({
                    x: approx.data32S[j * 2],
                    y: approx.data32S[j * 2 + 1]
                  });
                }
                approx.delete();
                if (this.isValidQuadGeometry(pts)) {
                  foundQuad = pts;
                  break;
                }
              } else {
                approx.delete();
              }
            }

            // Fallback for rounded / curved page contours: minimum oriented bounding box
            if (!foundQuad && area > totalArea * 0.12) {
              try {
                const rotRect = cv.minAreaRect(hull);
                if (rotRect && rotRect.size.width > 20 && rotRect.size.height > 20) {
                  const rrArea = rotRect.size.width * rotRect.size.height;
                  if (rrArea > totalArea * 0.08 && rrArea < totalArea * 0.95) {
                    const pts = this.getPointsFromRotatedRect(rotRect, downW, downH);
                    if (this.isValidQuadGeometry(pts)) {
                      foundQuad = pts;
                    }
                  }
                }
              } catch (_) {}
            }

            if (foundQuad) {
              const score = this.scoreQuadCandidate(foundQuad, area, totalArea);
              if (score > bestScore) {
                bestScore = score;
                bestQuad = foundQuad;
              }
            }

            hull.delete();
          }
          cnt.delete();
        }
      };

      evaluateContours(contours);
      evaluateContours(otsuContours);

      // If a clear document paper contour on background was found
      if (bestQuad && bestScore > 0.08) {
        const scaledPts = bestQuad.map(p => ({
          x: Math.max(0, Math.min(srcW, Math.round(p.x * scale))),
          y: Math.max(0, Math.min(srcH, Math.round(p.y * scale)))
        }));
        return {
          corners: this.orderQuadPoints(scaledPts),
          type: 'document'
        };
      }

      // If document fills frame or background lacks contrast, detect the salient text/table area
      const contentQuad = this.detectSalientContentOpenCv(gray, downW, downH, scale, srcW, srcH);
      if (contentQuad) {
        return {
          corners: contentQuad,
          type: 'content'
        };
      }

      return null;
    } catch (err) {
      console.warn('OpenCV detection pipeline error:', err);
      return null;
    } finally {
      if (src) src.delete();
      if (resized) resized.delete();
      if (gray) gray.delete();
      if (blurred) blurred.delete();
      if (edges) edges.delete();
      if (otsu) otsu.delete();
      if (otsuEdges) otsuEdges.delete();
      if (closeKernel) closeKernel.delete();
      if (gradKernel) gradKernel.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
      if (otsuContours) otsuContours.delete();
      if (otsuHierarchy) otsuHierarchy.delete();
    }
  }

  /**
   * Detects salient text, tables, lines, and form content using Sobel gradients
   */
  detectSalientContentOpenCv(gray, downW, downH, scale, srcW, srcH) {
    const cv = window.cv;
    let gradX = null;
    let gradY = null;
    let absX = null;
    let absY = null;
    let grad = null;
    let thresh = null;
    let contentKernel = null;
    let contentMap = null;
    let contours = null;
    let hierarchy = null;

    try {
      gradX = new cv.Mat();
      gradY = new cv.Mat();
      cv.Sobel(gray, gradX, cv.CV_16S, 1, 0, 3);
      cv.Sobel(gray, gradY, cv.CV_16S, 0, 1, 3);

      absX = new cv.Mat();
      absY = new cv.Mat();
      cv.convertScaleAbs(gradX, absX);
      cv.convertScaleAbs(gradY, absY);

      grad = new cv.Mat();
      cv.addWeighted(absX, 0.5, absY, 0.5, 0, grad);

      thresh = new cv.Mat();
      cv.threshold(grad, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

      // Horizontal structuring element groups text lines and tables into cohesive blocks
      const kw = Math.max(11, Math.round(downW * 0.035));
      const kh = Math.max(3, Math.round(downH * 0.015));
      contentKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, kh));

      contentMap = new cv.Mat();
      cv.morphologyEx(thresh, contentMap, cv.MORPH_CLOSE, contentKernel);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(contentMap, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let minX = downW;
      let minY = downH;
      let maxX = 0;
      let maxY = 0;
      let validBlocks = 0;
      const minBlockArea = (downW * downH) * 0.0006;

      for (let i = 0; i < contours.size(); ++i) {
        const c = contours.get(i);
        const cArea = cv.contourArea(c);
        if (cArea > minBlockArea) {
          const rect = cv.boundingRect(c);
          // Ignore perimeter frame lines
          if (rect.width < downW * 0.98 || rect.height < downH * 0.98) {
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);
            validBlocks++;
          }
        }
        c.delete();
      }

      const contentW = maxX - minX;
      const contentH = maxY - minY;

      if (validBlocks > 0 && contentW > downW * 0.15 && contentH > downH * 0.15) {
        // Add comfortable 4% margin around content
        const padX = Math.round(contentW * 0.04);
        const padY = Math.round(contentH * 0.035);

        const bMinX = Math.max(0, minX - padX);
        const bMinY = Math.max(0, minY - padY);
        const bMaxX = Math.min(downW, maxX + padX);
        const bMaxY = Math.min(downH, maxY + padY);

        const pts = [
          { x: bMinX * scale, y: bMinY * scale },
          { x: bMaxX * scale, y: bMinY * scale },
          { x: bMaxX * scale, y: bMaxY * scale },
          { x: bMinX * scale, y: bMaxY * scale }
        ];

        return this.orderQuadPoints(pts);
      }

      return null;
    } catch (err) {
      console.warn('Salient content detection failed:', err);
      return null;
    } finally {
      if (gradX) gradX.delete();
      if (gradY) gradY.delete();
      if (absX) absX.delete();
      if (absY) absY.delete();
      if (grad) grad.delete();
      if (thresh) thresh.delete();
      if (contentKernel) contentKernel.delete();
      if (contentMap) contentMap.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }
  }

  /**
   * Pure Canvas 2D fallback: detects content bounds and high-contrast boundaries
   * Operates instantly without needing external libraries.
   */
  detectWithCanvas2D(canvas) {
    if (!canvas || canvas.width <= 10 || canvas.height <= 10) return null;

    try {
      const srcW = canvas.width;
      const srcH = canvas.height;
      const maxDim = 400;
      const scale = Math.max(srcW, srcH) / maxDim;
      const targetW = Math.max(10, Math.round(srcW / scale));
      const targetH = Math.max(10, Math.round(srcH / scale));

      const offscreen = document.createElement('canvas');
      offscreen.width = targetW;
      offscreen.height = targetH;
      const ctx = offscreen.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, targetW, targetH);

      const imgData = ctx.getImageData(0, 0, targetW, targetH);
      const data = imgData.data;

      const rowEnergy = new Float32Array(targetH);
      const colEnergy = new Float32Array(targetW);

      for (let y = 0; y < targetH; y++) {
        for (let x = 0; x < targetW; x++) {
          const idx = (y * targetW + x) * 4;
          const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

          if (x > 0) {
            const prevIdx = (y * targetW + (x - 1)) * 4;
            const prevLuma = 0.299 * data[prevIdx] + 0.587 * data[prevIdx + 1] + 0.114 * data[prevIdx + 2];
            const diff = Math.abs(luma - prevLuma);
            rowEnergy[y] += diff;
            colEnergy[x] += diff;
          }
        }
      }

      let totalRow = 0;
      for (let y = 0; y < targetH; y++) totalRow += rowEnergy[y];
      const avgRow = totalRow / targetH;

      let totalCol = 0;
      for (let x = 0; x < targetW; x++) totalCol += colEnergy[x];
      const avgCol = totalCol / targetW;

      const rowThresh = Math.max(8, avgRow * 0.32);
      const colThresh = Math.max(8, avgCol * 0.32);

      let top = 0;
      for (let y = 0; y < targetH; y++) {
        if (rowEnergy[y] > rowThresh) { top = y; break; }
      }

      let bottom = targetH - 1;
      for (let y = targetH - 1; y >= 0; y--) {
        if (rowEnergy[y] > rowThresh) { bottom = y; break; }
      }

      let left = 0;
      for (let x = 0; x < targetW; x++) {
        if (colEnergy[x] > colThresh) { left = x; break; }
      }

      let right = targetW - 1;
      for (let x = targetW - 1; x >= 0; x--) {
        if (colEnergy[x] > colThresh) { right = x; break; }
      }

      const contentW = right - left;
      const contentH = bottom - top;

      if (contentW > targetW * 0.18 && contentH > targetH * 0.18) {
        const padX = Math.round(contentW * 0.04);
        const padY = Math.round(contentH * 0.035);

        const minX = Math.max(0, left - padX);
        const minY = Math.max(0, top - padY);
        const maxX = Math.min(targetW, right + padX);
        const maxY = Math.min(targetH, bottom + padY);

        const pts = [
          { x: minX * scale, y: minY * scale },
          { x: maxX * scale, y: minY * scale },
          { x: maxX * scale, y: maxY * scale },
          { x: minX * scale, y: maxY * scale }
        ];

        return {
          corners: this.orderQuadPoints(pts),
          type: 'content'
        };
      }
    } catch (err) {
      console.warn('Canvas 2D detection error:', err);
    }

    return null;
  }

  /**
   * Converts a RotatedRect to 4 oriented corner points
   */
  getPointsFromRotatedRect(rr, maxW, maxH) {
    const angleRad = (rr.angle * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const halfW = rr.size.width / 2;
    const halfH = rr.size.height / 2;

    const corners = [
      { x: -halfW, y: -halfH },
      { x: halfW, y: -halfH },
      { x: halfW, y: halfH },
      { x: -halfW, y: halfH }
    ];

    return corners.map(pt => ({
      x: Math.max(0, Math.min(maxW, rr.center.x + (pt.x * cos - pt.y * sin))),
      y: Math.max(0, Math.min(maxH, rr.center.y + (pt.x * sin + pt.y * cos)))
    }));
  }

  /**
   * Verifies that 4 points form a non-degenerate convex quad with reasonable angles
   */
  isValidQuadGeometry(pts) {
    if (!pts || pts.length !== 4) return false;

    // Reject point collapses
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 14) {
          return false;
        }
      }
    }

    // Interior angle check (45° to 135°)
    for (let i = 0; i < 4; i++) {
      const pPrev = pts[(i + 3) % 4];
      const pCurr = pts[i];
      const pNext = pts[(i + 1) % 4];

      const v1 = { x: pPrev.x - pCurr.x, y: pPrev.y - pCurr.y };
      const v2 = { x: pNext.x - pCurr.x, y: pNext.y - pCurr.y };

      const dot = v1.x * v2.x + v1.y * v2.y;
      const len1 = Math.hypot(v1.x, v1.y);
      const len2 = Math.hypot(v2.x, v2.y);
      if (len1 === 0 || len2 === 0) return false;

      const cosTheta = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      const angleDeg = Math.acos(cosTheta) * (180 / Math.PI);

      if (angleDeg < 45 || angleDeg > 135) {
        return false;
      }
    }

    return true;
  }

  /**
   * Scores candidate quads based on area and rectangularity
   */
  scoreQuadCandidate(pts, area, totalArea) {
    let angleDeviations = 0;
    for (let i = 0; i < 4; i++) {
      const pPrev = pts[(i + 3) % 4];
      const pCurr = pts[i];
      const pNext = pts[(i + 1) % 4];
      const v1 = { x: pPrev.x - pCurr.x, y: pPrev.y - pCurr.y };
      const v2 = { x: pNext.x - pCurr.x, y: pNext.y - pCurr.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const len1 = Math.hypot(v1.x, v1.y);
      const len2 = Math.hypot(v2.x, v2.y);
      const cosTheta = Math.max(-1, Math.min(1, dot / (len1 * len2)));
      const angleDeg = Math.acos(cosTheta) * (180 / Math.PI);
      angleDeviations += Math.abs(angleDeg - 90);
    }
    const avgDev = angleDeviations / 4;
    const rectScore = Math.max(0.2, 1 - (avgDev / 60));
    const areaRatio = area / totalArea;

    return areaRatio * rectScore;
  }

  /**
   * Sorts 4 points into Top-Left, Top-Right, Bottom-Right, Bottom-Left order
   * Using deterministic X-sort followed by Y-sort with cross-product winding validation.
   */
  orderQuadPoints(points) {
    if (!points || points.length !== 4) return null;

    const pts = points.map(p => ({ x: Number(p.x), y: Number(p.y) }));

    // Primary sorting: separate into Left and Right pairs
    pts.sort((a, b) => a.x - b.x);
    const leftPoints = pts.slice(0, 2).sort((a, b) => a.y - b.y);
    const rightPoints = pts.slice(2, 4).sort((a, b) => a.y - b.y);

    let tl = leftPoints[0];
    let bl = leftPoints[1];
    let tr = rightPoints[0];
    let br = rightPoints[1];

    // Cross-product validation for winding consistency: (tr - tl) x (bl - tl)
    const cross = (tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x);
    if (cross <= 0) {
      // Polar angle ordering relative to centroid for extreme rotation angles (> 45 deg)
      const cx = (tl.x + tr.x + br.x + bl.x) / 4;
      const cy = (tl.y + tr.y + br.y + bl.y) / 4;

      const sortedByAngle = pts.slice().sort((a, b) => {
        return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
      });

      let minSumIdx = 0;
      let minSum = Infinity;
      sortedByAngle.forEach((p, idx) => {
        const sum = p.x + p.y;
        if (sum < minSum) {
          minSum = sum;
          minSumIdx = idx;
        }
      });

      tl = sortedByAngle[minSumIdx];
      tr = sortedByAngle[(minSumIdx + 1) % 4];
      br = sortedByAngle[(minSumIdx + 2) % 4];
      bl = sortedByAngle[(minSumIdx + 3) % 4];
    }

    return { tl, tr, br, bl };
  }

  /**
   * Listens for OpenCV WebAssembly readiness to automatically upgrade detection
   */
  hookOpenCvReady() {
    if (window.cv && window.cv.Mat && (window.isOpenCvReady || typeof window.cv.imread === 'function')) return;
    if (this._openCvHookAttached) return;

    this._openCvHookAttached = true;

    if (window.Module) {
      const orig = window.Module.onRuntimeInitialized;
      window.Module.onRuntimeInitialized = () => {
        window.isOpenCvReady = true;
        if (typeof orig === 'function') orig();
        if (this.sourceCanvas && !this.userHasManuallyAdjusted) {
          this.autoDetectCorners();
        }
      };
    }

    let pollCount = 0;
    const pollId = setInterval(() => {
      pollCount++;
      if (window.cv && window.cv.Mat) {
        clearInterval(pollId);
        window.isOpenCvReady = true;
        if (this.sourceCanvas && !this.userHasManuallyAdjusted) {
          this.autoDetectCorners();
        }
      } else if (pollCount > 30) {
        clearInterval(pollId);
      }
    }, 350);
  }

  /**
   * Resets corners to an adaptive inset (4% from edges)
   */
  resetToAdaptiveInset() {
    if (!this.sourceCanvas) return;
    const w = this.sourceCanvas.width;
    const h = this.sourceCanvas.height;
    const marginX = Math.round(w * 0.04);
    const marginY = Math.round(h * 0.04);

    this.corners = {
      tl: { x: marginX, y: marginY },
      tr: { x: w - marginX, y: marginY },
      br: { x: w - marginX, y: h - marginY },
      bl: { x: marginX, y: h - marginY }
    };
    this.syncHandlesToCorners();
  }

  /**
   * Preserves backward compatibility
   */
  resetToDefaultInset() {
    this.resetToAdaptiveInset();
  }

  /**
   * Resets corners to full outer image boundaries
   */
  resetToFullImage() {
    if (!this.sourceCanvas) return;
    this.userHasManuallyAdjusted = true;
    const w = this.sourceCanvas.width;
    const h = this.sourceCanvas.height;

    this.corners = {
      tl: { x: 0, y: 0 },
      tr: { x: w, y: 0 },
      br: { x: w, y: h },
      bl: { x: 0, y: h }
    };
    this.syncHandlesToCorners();
  }

  /**
   * Syncs the visual handle DOM elements and SVG polygon with internal corners
   */
  syncHandlesToCorners() {
    if (!this.corners || !this.displayCanvas) return;

    const s = 1 / this.scaleFactor;
    const pointsStr = [
      `${this.corners.tl.x * s},${this.corners.tl.y * s}`,
      `${this.corners.tr.x * s},${this.corners.tr.y * s}`,
      `${this.corners.br.x * s},${this.corners.br.y * s}`,
      `${this.corners.bl.x * s},${this.corners.bl.y * s}`
    ].join(' ');

    if (this.polygonEl) {
      this.polygonEl.setAttribute('points', pointsStr);
    }

    ['tl', 'tr', 'br', 'bl'].forEach(key => {
      const handle = this.handles[key];
      if (handle) {
        handle.style.left = `${this.corners[key].x * s}px`;
        handle.style.top = `${this.corners[key].y * s}px`;
      }
    });
  }

  /**
   * Sets up touch and mouse drag listeners for handles
   */
  setupEventListeners() {
    const handleKeys = ['tl', 'tr', 'br', 'bl'];

    handleKeys.forEach(key => {
      const handle = this.handles[key];
      if (!handle) return;

      const startDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.userHasManuallyAdjusted = true;
        this.activeCornerKey = key;
        handle.classList.add('active');
        if (navigator.vibrate) {
          try { navigator.vibrate(15); } catch (_) {}
        }
        this.showLoupe();
        this.updateLoupe(this.corners[key]);
      };

      handle.addEventListener('mousedown', startDrag);
      handle.addEventListener('touchstart', startDrag, { passive: false });
    });

    const onPointerMove = (e) => {
      if (!this.activeCornerKey || !this.displayCanvas) return;
      e.preventDefault();

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const rect = this.displayCanvas.getBoundingClientRect();
      let displayX = clientX - rect.left;
      let displayY = clientY - rect.top;

      // Clamp within display bounds
      displayX = Math.max(0, Math.min(rect.width, displayX));
      displayY = Math.max(0, Math.min(rect.height, displayY));

      // Convert to native image pixels
      const nativeX = Math.round(displayX * this.scaleFactor);
      const nativeY = Math.round(displayY * this.scaleFactor);

      this.corners[this.activeCornerKey] = { x: nativeX, y: nativeY };
      this.syncHandlesToCorners();

      // Update magnifier loupe
      this.updateLoupe(this.corners[this.activeCornerKey], displayX, displayY);
    };

    const onPointerEnd = () => {
      if (this.activeCornerKey) {
        const handle = this.handles[this.activeCornerKey];
        if (handle) handle.classList.remove('active');
        this.activeCornerKey = null;
        this.hideLoupe();
      }
    };

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerEnd);
    window.addEventListener('touchend', onPointerEnd);

    const handleResize = () => {
      if (this.sourceCanvas) {
        this.renderDisplay();
        this.syncHandlesToCorners();
      }
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', () => {
      setTimeout(handleResize, 150);
    });

    if (window.ResizeObserver && this.workspaceEl) {
      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(this.workspaceEl);
    }
  }

  /**
   * Displays the magnifying loupe lens
   */
  showLoupe() {
    if (this.loupeEl) {
      this.loupeEl.classList.remove('hidden');
    }
  }

  /**
   * Hides the magnifying loupe lens
   */
  hideLoupe() {
    if (this.loupeEl) {
      this.loupeEl.classList.add('hidden');
    }
  }

  /**
   * Updates loupe canvas content with a 2.5x zoomed view
   */
  updateLoupe(cornerCoord, displayX, displayY) {
    if (!this.loupeEl || !this.loupeCanvas || !this.loupeCtx || !this.sourceCanvas) return;

    const zoom = 2.5;
    const loupeSize = 130;
    const srcRadius = (loupeSize / zoom) / 2;

    this.loupeCtx.clearRect(0, 0, loupeSize, loupeSize);

    // Draw zoomed portion from sourceCanvas
    this.loupeCtx.drawImage(
      this.sourceCanvas,
      cornerCoord.x - srcRadius,
      cornerCoord.y - srcRadius,
      srcRadius * 2,
      srcRadius * 2,
      0,
      0,
      loupeSize,
      loupeSize
    );

    // Position loupe offset from touch/mouse position
    const s = 1 / this.scaleFactor;
    const posX = displayX !== undefined ? displayX : cornerCoord.x * s;
    const posY = displayY !== undefined ? displayY : cornerCoord.y * s;

    // Smart vertical positioning: flip below finger if too close to top edge
    // Prevents the loupe from being clipped outside the container by overflow:hidden
    const flipBelow = posY < 135;
    if (flipBelow) {
      this.loupeEl.style.transform = 'translate(-50%, 35px)';
    } else {
      this.loupeEl.style.transform = 'translate(-50%, -145%)';
    }

    // Clamp horizontal position so the loupe circle never bleeds off canvas edges
    const minX = 65;
    const maxX = Math.max(minX, (this.displayCanvas.width || 300) - 65);
    const clampedX = Math.max(minX, Math.min(maxX, posX));

    this.loupeEl.style.left = `${clampedX}px`;
    this.loupeEl.style.top = `${posY}px`;
  }

  /**
   * Performs 4-point perspective transform to produce a flattened document
   * @returns {HTMLCanvasElement} flattened document canvas
   */
  warpDocument() {
    if (!this.sourceCanvas || !this.corners) {
      throw new Error('No source image or corners defined.');
    }

    const { tl, tr, br, bl } = this.corners;

    // Euclidean distance calculation
    const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

    const widthTop = dist(tl, tr);
    const widthBottom = dist(bl, br);
    const targetWidth = Math.round(Math.max(widthTop, widthBottom));

    const heightLeft = dist(tl, bl);
    const heightRight = dist(tr, br);
    const targetHeight = Math.round(Math.max(heightLeft, heightRight));

    // Ensure valid output dimensions
    if (targetWidth <= 10 || targetHeight <= 10) {
      throw new Error('Selected crop region is too small.');
    }

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = targetWidth;
    outputCanvas.height = targetHeight;

    if (window.cv && window.cv.Mat) {
      const cv = window.cv;
      const srcMat = cv.imread(this.sourceCanvas);
      const dstMat = new cv.Mat();

      // Source quadrilateral points (Float32Array)
      const srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y,
        tr.x, tr.y,
        br.x, br.y,
        bl.x, bl.y
      ]);

      // Destination rectangular points
      const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        targetWidth, 0,
        targetWidth, targetHeight,
        0, targetHeight
      ]);

      // Compute perspective transform matrix
      const M = cv.getPerspectiveTransform(srcCoords, dstCoords);
      const dsize = new cv.Size(targetWidth, targetHeight);

      // Warp perspective using bicubic interpolation for crisp document typography without softening
      const interp = (cv.INTER_CUBIC !== undefined) ? cv.INTER_CUBIC : 2;
      cv.warpPerspective(srcMat, dstMat, M, dsize, interp, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

      // Render to output canvas
      cv.imshow(outputCanvas, dstMat);

      // Clean up Mats
      srcMat.delete();
      dstMat.delete();
      srcCoords.delete();
      dstCoords.delete();
      M.delete();
    } else {
      // Fallback bounding box crop if OpenCV is not ready
      const minX = Math.max(0, Math.min(tl.x, bl.x));
      const minY = Math.max(0, Math.min(tl.y, tr.y));
      const maxX = Math.min(this.sourceCanvas.width, Math.max(tr.x, br.x));
      const maxY = Math.min(this.sourceCanvas.height, Math.max(bl.y, br.y));
      const cropW = Math.max(10, maxX - minX);
      const cropH = Math.max(10, maxY - minY);

      outputCanvas.width = cropW;
      outputCanvas.height = cropH;
      const ctx = outputCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.sourceCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
    }

    return outputCanvas;
  }
}

// Export singleton instance
window.cropperManager = new CropperManager();
