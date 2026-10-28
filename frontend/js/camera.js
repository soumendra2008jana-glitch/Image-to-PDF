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

    const isPortrait = window.innerHeight > window.innerWidth;
    const targetIdealW = isPortrait ? 2160 : 3840;
    const targetIdealH = isPortrait ? 3840 : 2160;

    // Cascading resolution constraints: avoids rigid 'min' thresholds that cause OverconstrainedError on portrait phones
    const candidates = [
      // 1. Ultra-High Resolution (4K UHD)
      {
        video: {
          facingMode: { ideal: this.currentFacingMode },
          width: { ideal: targetIdealW },
          height: { ideal: targetIdealH }
        },
        audio: false
      },
      // 2. Full HD (1080p)
      {
        video: {
          facingMode: { ideal: this.currentFacingMode },
          width: { ideal: isPortrait ? 1080 : 1920 },
          height: { ideal: isPortrait ? 1920 : 1080 }
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
   * Captures the current video frame onto a canvas at native video resolution.
   * Priority 1: W3C ImageCapture API for full native sensor resolution (12MP - 48MP)
   * Priority 2: Full-resolution video element frame draw with high-quality smoothing
   * @param {HTMLCanvasElement} [targetCanvas]
   * @returns {Promise<HTMLCanvasElement>}
   */
  async captureFrame(targetCanvas = null) {
    if (!this.videoElement || !this.stream) {
      throw new Error('Camera is not active.');
    }

    const track = this.stream.getVideoTracks()[0];

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
          photoBlob = await imageCapture.takePhoto(Object.keys(photoSettings).length > 0 ? photoSettings : undefined);
        } catch (_) {
          photoBlob = await imageCapture.takePhoto().catch(() => null);
        }

        if (photoBlob && photoBlob.size > 0) {
          const bitmap = await createImageBitmap(photoBlob);
          if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
            const canvas = targetCanvas || document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0);
            return canvas;
          }
        }
      } catch (_) {
        // Fall back to high-res video element capture below
      }
    }

    // Priority 2: Video Element Full Resolution Frame Grab
    const video = this.videoElement;
    const width = video.videoWidth || 1920;
    const height = video.videoHeight || 1080;

    const canvas = targetCanvas || document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, width, height);

    return canvas;
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
