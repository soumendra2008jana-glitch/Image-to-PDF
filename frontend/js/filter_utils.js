/**
 * WebScan - Filter & Document Enhancement Utilities
 * Provides:
 * - 'Original': Clean source image with optional brightness/contrast tuning
 * - 'Magic Color': Unsharp masking + contrast stretching for vivid readable documents
 * - 'B&W Document': OpenCV adaptive thresholding for crisp black text on pure white paper
 * - 'Grayscale': Balanced monochrome conversion
 * - Brightness & Contrast fine adjustments
 * - Safe memory lifecycle for OpenCV Mats
 */

class FilterManager {
  constructor() {
    this.sourceCanvas = null;  // Unmodified warped document
    this.presetCanvas = null;  // Offscreen canvas storing the preset-filtered base image
    this.targetCanvas = null;  // Display & export canvas
    this.currentPreset = 'original';
    this.renderedPreset = null; // Track which preset is baked in presetCanvas
    this.brightness = 0;       // -100 to 100
    this.contrast = 0;         // -100 to 100
  }

  /**
   * Initializes the filter manager with the warped source canvas
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {HTMLCanvasElement} targetCanvas
   */
  init(sourceCanvas, targetCanvas) {
    this.sourceCanvas = sourceCanvas;
    this.targetCanvas = targetCanvas;
    if (this.targetCanvas && this.targetCanvas.getContext) {
      this.targetCanvas.getContext('2d', { willReadFrequently: true });
    }
    this.presetCanvas = null;
    this.renderedPreset = null;
    this.currentPreset = 'original';
    this.brightness = 0;
    this.contrast = 0;
  }

  /**
   * Rotates the warped image 90 degrees clockwise
   */
  rotateWarped() {
    if (!this.sourceCanvas) return;

    const oldW = this.sourceCanvas.width;
    const oldH = this.sourceCanvas.height;

    const rot = document.createElement('canvas');
    rot.width = oldH;
    rot.height = oldW;

    const ctx = rot.getContext('2d');
    ctx.translate(oldH / 2, oldW / 2);
    ctx.rotate((90 * Math.PI) / 180);
    ctx.drawImage(this.sourceCanvas, -oldW / 2, -oldH / 2);

    this.sourceCanvas = rot;
    this.presetCanvas = null;
    this.renderedPreset = null;
    return this.applyCurrent(true);
  }

  /**
   * Applies the selected preset with active brightness and contrast values
   * @param {string} [preset]
   * @param {number} [brightness]
   * @param {number} [contrast]
   * @returns {HTMLCanvasElement}
   */
  apply(preset = this.currentPreset, brightness = this.brightness, contrast = this.contrast) {
    const presetChanged = (preset !== this.currentPreset || this.renderedPreset !== preset);
    this.currentPreset = preset;
    this.brightness = brightness;
    this.contrast = contrast;

    return this.applyCurrent(presetChanged);
  }

  /**
   * Fast dedicated adjustment for brightness/contrast sliders.
   * Reuses the cached preset canvas to achieve buttery-smooth 60fps adjustments
   * without re-running heavy OpenCV filters.
   * @param {number} [brightness]
   * @param {number} [contrast]
   * @returns {HTMLCanvasElement}
   */
  adjustBrightnessContrast(brightness = this.brightness, contrast = this.contrast) {
    this.brightness = brightness;
    this.contrast = contrast;

    if (!this.presetCanvas || this.renderedPreset !== this.currentPreset) {
      this.renderPresetBase();
    }

    return this.applyBrightnessContrastFast();
  }

  /**
   * Internal render dispatcher
   * @param {boolean} [forcePresetRerender=false]
   */
  applyCurrent(forcePresetRerender = false) {
    if (!this.sourceCanvas || !this.targetCanvas) return null;

    if (forcePresetRerender || !this.presetCanvas || this.renderedPreset !== this.currentPreset) {
      this.renderPresetBase();
    }

    return this.applyBrightnessContrastFast();
  }

  /**
   * Renders the base preset (OpenCV or Canvas2D) once into this.presetCanvas
   */
  renderPresetBase() {
    if (!this.sourceCanvas) return;

    if (!this.presetCanvas) {
      this.presetCanvas = document.createElement('canvas');
    }
    this.presetCanvas.width = this.sourceCanvas.width;
    this.presetCanvas.height = this.sourceCanvas.height;

    const hasOpenCV = !!(window.cv && window.cv.Mat);

    if (hasOpenCV) {
      try {
        this.applyWithOpenCV(this.sourceCanvas, this.presetCanvas);
      } catch (err) {
        console.warn('OpenCV filter failed, falling back to Canvas 2D:', err);
        this.applyWithCanvas2D(this.sourceCanvas, this.presetCanvas);
      }
    } else {
      this.applyWithCanvas2D(this.sourceCanvas, this.presetCanvas);
    }

    this.renderedPreset = this.currentPreset;
  }

  /**
   * OpenCV-powered document filtering (outputs to targetCanvas)
   */
  /**
   * OpenCV-powered document filtering (outputs to targetCanvas)
   */
  applyWithOpenCV(sourceCanvas, targetCanvas) {
    const cv = window.cv;
    const src = cv.imread(sourceCanvas);
    let dst = new cv.Mat();

    let gray = null;
    let rgb = null;
    let bgKernel = null;
    let bg = null;
    let norm = null;
    let thresh = null;
    let blended = null;
    let blurred = null;
    let sharpened = null;
    let rgbPlanes = null;

    try {
      switch (this.currentPreset) {
        case 'grayscale': {
          gray = new cv.Mat();
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
          cv.cvtColor(gray, dst, cv.COLOR_GRAY2RGBA);
          break;
        }

        case 'bw': {
          // High-fidelity background illumination whitening + anti-aliased character preservation
          gray = new cv.Mat();
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

          // Morphological closing estimates background paper illumination
          const ksize = Math.max(17, Math.min(41, Math.round(src.cols / 50))) | 1;
          bgKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ksize, ksize));
          bg = new cv.Mat();
          cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, bgKernel);

          // Normalize: divide gray by background illumination map so shadows/yellowing disappear
          norm = new cv.Mat();
          cv.divide(gray, bg, norm, 255.0);

          // Adaptive threshold with moderate C (5 instead of harsh 10) on normalized image
          const blockSize = Math.max(15, Math.min(51, Math.floor(src.cols / 40))) | 1;
          thresh = new cv.Mat();
          cv.adaptiveThreshold(
            norm,
            thresh,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY,
            blockSize,
            5
          );

          // Blend normalized text anti-aliasing with threshold mask for smooth, razor-sharp typography
          // (Prevents pixelated jagged staircasing while eliminating all background shadows)
          blended = new cv.Mat();
          cv.min(norm, thresh, blended);

          cv.cvtColor(blended, dst, cv.COLOR_GRAY2RGBA);
          break;
        }

        case 'magic': {
          // Magic Color: High-fidelity color enhancement without hue quantization
          rgb = new cv.Mat();
          cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

          // Subtle unsharp mask for sharp text definition without halo artifacts
          blurred = new cv.Mat();
          cv.GaussianBlur(rgb, blurred, new cv.Size(0, 0), 1.2);
          sharpened = new cv.Mat();
          cv.addWeighted(rgb, 1.25, blurred, -0.25, 0, sharpened);

          // Clean background lighting without color distortion
          gray = new cv.Mat();
          cv.cvtColor(sharpened, gray, cv.COLOR_RGB2GRAY);

          const ksize = Math.max(21, Math.min(45, Math.round(src.cols / 45))) | 1;
          bgKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ksize, ksize));
          bg = new cv.Mat();
          cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, bgKernel);

          // Divide each RGB channel by background illumination to whiten paper while preserving 100% color fidelity
          rgbPlanes = new cv.MatVector();
          cv.split(sharpened, rgbPlanes);

          for (let c = 0; c < 3; c++) {
            const channel = rgbPlanes.get(c);
            cv.divide(channel, bg, channel, 255.0);
            rgbPlanes.set(c, channel);
            channel.delete();
          }

          cv.merge(rgbPlanes, dst);
          cv.cvtColor(dst, dst, cv.COLOR_RGB2RGBA);
          break;
        }

        case 'original':
        default: {
          src.copyTo(dst);
          break;
        }
      }

      cv.imshow(targetCanvas, dst);
    } finally {
      if (src) src.delete();
      if (dst) dst.delete();
      if (gray) gray.delete();
      if (rgb) rgb.delete();
      if (bgKernel) bgKernel.delete();
      if (bg) bg.delete();
      if (norm) norm.delete();
      if (thresh) thresh.delete();
      if (blended) blended.delete();
      if (blurred) blurred.delete();
      if (sharpened) sharpened.delete();
      if (rgbPlanes) rgbPlanes.delete();
    }
  }

  /**
   * Fallback pure Canvas 2D image processing (outputs to targetCanvas)
   */
  applyWithCanvas2D(sourceCanvas, targetCanvas) {
    const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0);

    const imgData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
    const d = imgData.data;

    if (this.currentPreset === 'grayscale') {
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = gray;
        d[i + 1] = gray;
        d[i + 2] = gray;
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (this.currentPreset === 'bw') {
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // Smooth threshold curve preserving character anti-aliasing
        const val = gray > 185 ? 255 : Math.max(0, (gray - 40) * 1.7);
        d[i] = val;
        d[i + 1] = val;
        d[i + 2] = val;
      }
      ctx.putImageData(imgData, 0, 0);
    } else if (this.currentPreset === 'magic') {
      for (let i = 0; i < d.length; i += 4) {
        // High-fidelity color boost with clean white paper background
        d[i] = Math.min(255, Math.max(0, (d[i] - 120) * 1.15 + 128));
        d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 120) * 1.15 + 128));
        d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 120) * 1.15 + 128));
      }
      ctx.putImageData(imgData, 0, 0);
    }
  }

  /**
   * High-performance brightness & contrast adjustment using a 256-entry lookup table (LUT).
   * Copies directly from presetCanvas and applies in < 2ms, maintaining full 60fps UI.
   */
  applyBrightnessContrastFast() {
    if (!this.presetCanvas || !this.targetCanvas) return this.targetCanvas;

    const w = this.presetCanvas.width;
    const h = this.presetCanvas.height;

    if (this.targetCanvas.width !== w || this.targetCanvas.height !== h) {
      this.targetCanvas.width = w;
      this.targetCanvas.height = h;
    }

    const ctx = this.targetCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.presetCanvas, 0, 0);

    // Fast-exit if neutral values
    if (this.brightness === 0 && this.contrast === 0) {
      return this.targetCanvas;
    }

    // Precompute 256-byte Lookup Table (LUT)
    const factor = (259 * (this.contrast + 255)) / (255 * (259 - this.contrast));
    const bOffset = this.brightness * 1.28;

    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = factor * (i - 128) + 128 + bOffset;
    }

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const len = d.length;

    for (let i = 0; i < len; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }

    ctx.putImageData(imgData, 0, 0);
    return this.targetCanvas;
  }

  /**
   * Export final filtered canvas to a high-fidelity Blob (default 0.98 quality)
   * Uses lossless PNG for 'bw' document mode and 0.98 JPEG for color/grayscale.
   * @param {number} [quality=0.98]
   * @returns {Promise<Blob>}
   */
  getFilteredBlob(quality = 0.98) {
    return new Promise((resolve) => {
      const mimeType = this.currentPreset === 'bw' ? 'image/png' : 'image/jpeg';
      this.targetCanvas.toBlob((blob) => {
        resolve(blob);
      }, mimeType, quality);
    });
  }

  /**
   * Export final filtered canvas as base64 Data URL (default 0.98 quality)
   * @param {number} [quality=0.98]
   */
  getFilteredDataURL(quality = 0.98) {
    const mimeType = this.currentPreset === 'bw' ? 'image/png' : 'image/jpeg';
    return this.targetCanvas.toDataURL(mimeType, quality);
  }
}

// Export singleton instance
window.filterManager = new FilterManager();
