/**
 * WebScan - Camera Controller Module
 * Simple, standard JavaScript implementation using navigator.mediaDevices.getUserMedia
 */

class CameraController {
  constructor() {
    this.videoElement = null;
    this.stream = null;
    this.currentFacingMode = 'environment'; // Prefer rear camera for documents
    this.hasTorch = false;
    this.isTorchOn = false;
    this.flashMode = 'on'; // 'on' (flash light fires on capture) | 'off'
  }

  /**
   * Toggles flash-on-capture mode ('on' <-> 'off')
   * @returns {string} current flash mode
   */
  toggleFlashMode() {
    this.flashMode = (this.flashMode === 'on') ? 'off' : 'on';
    return this.flashMode;
  }

  /**
   * Checks if flash on capture is enabled
   * @returns {boolean}
   */
  isFlashEnabled() {
    return this.flashMode === 'on';
  }

  /**
   * Triggers an animated screen flash burst for visual illumination and feedback
   */
  triggerScreenFlash() {
    let overlay = document.getElementById('camera-flash-overlay');
    if (!overlay && this.videoElement && this.videoElement.parentElement) {
      overlay = document.createElement('div');
      overlay.id = 'camera-flash-overlay';
      overlay.className = 'camera-flash-overlay';
      this.videoElement.parentElement.appendChild(overlay);
    }
    if (overlay) {
      overlay.classList.add('flash-firing');
      requestAnimationFrame(() => {
        setTimeout(() => {
          overlay.classList.remove('flash-firing');
        }, 120);
      });
    }
  }

  /**
   * Crops a canvas, bitmap or image to standard 9:16 portrait aspect ratio (centered).
   * Ensures output canvas is always in 9:16 portrait mode.
   * @param {HTMLCanvasElement|ImageBitmap|HTMLImageElement} source
   * @param {HTMLCanvasElement} [targetCanvas]
   * @returns {HTMLCanvasElement}
   */
  cropToPortrait916(source, targetCanvas = null) {
    const srcW = source.width || source.naturalWidth || 1080;
    const srcH = source.height || source.naturalHeight || 1920;

    const targetRatio = 9 / 16; // 0.5625 portrait ratio
    const currentRatio = srcW / srcH;

    let cropX = 0;
    let cropY = 0;
    let cropW = srcW;
    let cropH = srcH;

    if (currentRatio > targetRatio) {
      // Source is wider than 9:16 (e.g. landscape or 4:3) -> crop left & right
      cropW = Math.round(srcH * targetRatio);
      cropH = srcH;
      cropX = Math.round((srcW - cropW) / 2);
      cropY = 0;
    } else if (currentRatio < targetRatio) {
      // Source is taller than 9:16 -> crop top & bottom
      cropW = srcW;
      cropH = Math.round(srcW / targetRatio);
      cropX = 0;
      cropY = Math.round((srcH - cropH) / 2);
    }

    const canvas = targetCanvas || document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    return canvas;
  }

  /**
   * Checks if camera API is supported in the current browser/context
   */
  isSupported() {
    return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  /**
   * Checks whether the current context is secure (HTTPS or localhost)
   */
  getSecurityContext() {
    const isLocalhost = Boolean(
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );
    const isHttps = window.location.protocol === 'https:';
    const isSecure = Boolean(window.isSecureContext || isLocalhost || isHttps);
    return { isSecure, isLocalhost, isHttps };
  }

  /**
   * Starts the camera with simple standard JavaScript
   * @param {HTMLVideoElement} videoElement
   * @param {string} [facingMode='environment']
   */
  async startCamera(videoElement, facingMode = this.currentFacingMode) {
    this.videoElement = videoElement;
    this.currentFacingMode = facingMode;

    // Release any previous active camera tracks
    this.stopCamera();

    if (!this.isSupported()) {
      const { isSecure } = this.getSecurityContext();
      if (!isSecure) {
        throw new Error('Live camera requires HTTPS or localhost. To scan from a phone over Wi-Fi, tap "Take Photo with Phone Camera" below.');
      }
      throw new Error('Camera is not supported on this browser.');
    }

    // Configure video attributes for silent autoplay across mobile and desktop
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.setAttribute('playsinline', '');
    this.videoElement.setAttribute('muted', '');
    this.videoElement.setAttribute('autoplay', '');

    // Cascading resolution constraints: prioritizes 9:16 portrait ratio without rigid 'min' thresholds
    const candidates = [
      // 1. High Resolution Portrait 9:16 (4K UHD)
      {
        video: {
          facingMode: { ideal: this.currentFacingMode },
          aspectRatio: { ideal: 9 / 16 },
          width: { ideal: 2160 },
          height: { ideal: 3840 }
        },
        audio: false
      },
      // 2. Full HD Portrait 9:16 (1080x1920)
      {
        video: {
          facingMode: { ideal: this.currentFacingMode },
          aspectRatio: { ideal: 9 / 16 },
          width: { ideal: 1080 },
          height: { ideal: 1920 }
        },
        audio: false
      },
      // 3. Any high resolution on desired camera
      {
        video: {
          facingMode: { ideal: this.currentFacingMode }
        },
        audio: false
      },
      // 4. Fallback to default camera
      {
        video: true,
        audio: false
      }
    ];

    let stream = null;
    let lastError = null;

    for (const constraints of candidates) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream) break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!stream) {
      throw this.formatError(lastError);
    }

    this.stream = stream;
    this.videoElement.srcObject = stream;

    // Apply continuous hardware autofocus and exposure if supported
    const track = stream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      try {
        const caps = track.getCapabilities();
        const advanced = {};
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          advanced.focusMode = 'continuous';
        }
        if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
          advanced.exposureMode = 'continuous';
        }
        if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) {
          advanced.whiteBalanceMode = 'continuous';
        }
        if (Object.keys(advanced).length > 0) {
          await track.applyConstraints({ advanced: [advanced] }).catch(() => {});
        }
      } catch (_) {}
    }

    // Safely start video playback
    try {
      await this.videoElement.play();
    } catch (_) {
      // Autoplay may wait for user gesture; safely handled
    }

    // Synchronize viewfinder guide overlay with actual visible video bounds (eliminates zoom mismatch)
    if (this._onMetadataHandler) {
      this.videoElement.removeEventListener('loadedmetadata', this._onMetadataHandler);
      window.removeEventListener('resize', this._onMetadataHandler);
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
    }
    this._onMetadataHandler = () => this.updateViewfinderBounds();
    this.videoElement.addEventListener('loadedmetadata', this._onMetadataHandler);
    window.addEventListener('resize', this._onMetadataHandler);

    const container = this.videoElement.parentElement;
    if (container && window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this.updateViewfinderBounds());
      this._resizeObserver.observe(container);
    }

    if (this.videoElement.videoWidth) {
      this.updateViewfinderBounds();
    }

    this.checkCapabilities();
    return true;
  }

  /**
   * Adjusts the viewfinder overlay so the corner guides and laser line match
   * the exact visible video bounds (accounting for aspect ratio letterboxing)
   */
  updateViewfinderBounds() {
    if (!this.videoElement || !this.videoElement.videoWidth) return;
    const container = this.videoElement.parentElement;
    if (!container) return;

    const vW = this.videoElement.videoWidth;
    const vH = this.videoElement.videoHeight;
    const cW = container.clientWidth;
    const cH = container.clientHeight;

    if (!vW || !vH || !cW || !cH) return;

    const videoRatio = vW / vH;
    const containerRatio = cW / cH;

    let renderW, renderH, renderX, renderY;

    if (videoRatio > containerRatio) {
      // Letterbox top and bottom
      renderW = cW;
      renderH = cW / videoRatio;
      renderX = 0;
      renderY = (cH - renderH) / 2;
    } else {
      // Letterbox left and right
      renderH = cH;
      renderW = cH * videoRatio;
      renderX = (cW - renderW) / 2;
      renderY = 0;
    }

    const overlay = document.getElementById('viewfinder');
    if (overlay) {
      const inset = Math.min(20, Math.min(renderW, renderH) * 0.04);
      overlay.style.top = `${Math.round(renderY + inset)}px`;
      overlay.style.left = `${Math.round(renderX + inset)}px`;
      overlay.style.width = `${Math.round(renderW - (inset * 2))}px`;
      overlay.style.height = `${Math.round(renderH - (inset * 2))}px`;
      overlay.style.bottom = 'auto';
      overlay.style.right = 'auto';
    }
  }

  /**
   * Toggles between front and rear cameras
   */
  async switchCamera() {
    const nextMode = this.currentFacingMode === 'environment' ? 'user' : 'environment';
    return await this.startCamera(this.videoElement, nextMode);
  }

  /**
   * Checks if torch / flashlight is supported on the active video track
   */
  checkCapabilities() {
    if (!this.stream) {
      this.hasTorch = false;
      return;
    }
    const track = this.stream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      try {
        const caps = track.getCapabilities();
        this.hasTorch = Boolean(caps && caps.torch);
      } catch (_) {
        this.hasTorch = false;
      }
    } else {
      this.hasTorch = false;
    }
  }

  /**
   * Toggles the torch / flashlight
   */
  async toggleTorch() {
    if (!this.stream || !this.hasTorch) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return false;

    try {
      this.isTorchOn = !this.isTorchOn;
      await track.applyConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });
      return this.isTorchOn;
    } catch (_) {
      this.isTorchOn = false;
      return false;
    }
  }

  /**
   * Captures the current video frame onto a canvas in 9:16 portrait mode.
   * Priority 1: Hardware Still Photo via W3C ImageCapture API (12MP - 48MP)
   * Priority 2: Video Element Full Resolution Frame Grab
   * Features:
   * - Starts flash light / hardware torch automatically when capturing if flashMode is 'on'
   * - Formats output canvas to exact 9:16 portrait aspect ratio
   * @param {HTMLCanvasElement} [targetCanvas]
   * @param {Object} [options]
   * @returns {Promise<HTMLCanvasElement>}
   */
  async captureFrame(targetCanvas = null, options = {}) {
    if (!this.videoElement || !this.stream) {
      throw new Error('Camera is not active.');
    }

    const track = this.stream.getVideoTracks()[0];
    const shouldFlash = (options.flash !== undefined) ? options.flash : (this.flashMode === 'on');
    let torchActivated = false;

    // 1. Activate Flash light when capturing image (Hardware torch + visual screen flash burst)
    if (shouldFlash) {
      this.triggerScreenFlash();

      if (track) {
        try {
          const caps = (typeof track.getCapabilities === 'function') ? track.getCapabilities() : {};
          if (caps && caps.torch) {
            await track.applyConstraints({
              advanced: [{ torch: true }]
            }).catch(() => {});
            torchActivated = true;
          }
        } catch (_) {}
      }

      // Small pause to allow camera sensor auto-exposure to adapt to flash illumination
      await new Promise(resolve => setTimeout(resolve, torchActivated ? 160 : 70));
    }

    let capturedRaw = null;

    try {
      // Priority 1: Hardware Still Photo via ImageCapture API (Android Chrome & Chromium)
      if (window.ImageCapture && track && track.readyState === 'live') {
        try {
          const imageCapture = new ImageCapture(track);
          let photoBlob = null;
          try {
            const photoCaps = (typeof imageCapture.getPhotoCapabilities === 'function')
              ? await imageCapture.getPhotoCapabilities().catch(() => null)
              : null;
            const photoSettings = {};
            if (photoCaps && photoCaps.imageWidth && photoCaps.imageWidth.max) {
              photoSettings.imageWidth = photoCaps.imageWidth.max;
            }
            if (photoCaps && photoCaps.imageHeight && photoCaps.imageHeight.max) {
              photoSettings.imageHeight = photoCaps.imageHeight.max;
            }
            if (shouldFlash && photoCaps && photoCaps.fillLightMode && photoCaps.fillLightMode.includes('flash')) {
              photoSettings.fillLightMode = 'flash';
            }
            photoBlob = await imageCapture.takePhoto(Object.keys(photoSettings).length > 0 ? photoSettings : undefined);
          } catch (_) {
            photoBlob = await imageCapture.takePhoto().catch(() => null);
          }

          if (photoBlob && photoBlob.size > 0) {
            const bitmap = await createImageBitmap(photoBlob);
            if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
              capturedRaw = bitmap;
            }
          }
        } catch (_) {
          // Fall back to high-res video element capture below
        }
      }

      // Priority 2: Video Element Full Resolution Frame Grab
      if (!capturedRaw) {
        const video = this.videoElement;
        const width = video.videoWidth || 1080;
        const height = video.videoHeight || 1920;

        const vCanvas = document.createElement('canvas');
        vCanvas.width = width;
        vCanvas.height = height;
        const ctx = vCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, 0, 0, width, height);
        capturedRaw = vCanvas;
      }
    } finally {
      // Turn off hardware flash torch after capture completes
      if (torchActivated && track && !this.isTorchOn) {
        try {
          await track.applyConstraints({
            advanced: [{ torch: false }]
          }).catch(() => {});
        } catch (_) {}
      }
    }

    // Always output a crisp 9:16 portrait ratio canvas
    return this.cropToPortrait916(capturedRaw, targetCanvas);
  }

  /**
   * Stops active camera tracks and frees hardware resources
   */
  stopCamera() {
    if (this._onMetadataHandler && this.videoElement) {
      this.videoElement.removeEventListener('loadedmetadata', this._onMetadataHandler);
      window.removeEventListener('resize', this._onMetadataHandler);
      this._onMetadataHandler = null;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (_) {}
      });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.isTorchOn = false;

    // Reset viewfinder to default container bounds
    const overlay = document.getElementById('viewfinder');
    if (overlay) {
      overlay.style.top = '';
      overlay.style.left = '';
      overlay.style.width = '';
      overlay.style.height = '';
      overlay.style.bottom = '';
      overlay.style.right = '';
    }
  }

  /**
   * Checks if the camera is currently streaming
   */
  isActive() {
    return Boolean(this.stream && this.stream.active);
  }

  /**
   * Formats DOMExceptions into clear, actionable messages
   */
  formatError(err) {
    if (!err) return new Error('Could not access camera.');

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return new Error('Camera permission was denied. Tap the 🔒 lock in your browser address bar to Allow camera access.');
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return new Error('No camera hardware was found on this device.');
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return new Error('Camera is in use by another app or browser tab.');
    }
    return new Error(err.message || 'Could not access camera.');
  }
}

// Export singleton instance
window.cameraController = new CameraController();
