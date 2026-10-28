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

    let stream = null;

    // 1. Try with ideal facingMode and ultra-high-definition resolution (up to 4K)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.currentFacingMode },
          width: { ideal: 3840, min: 1280 },
          height: { ideal: 2160, min: 720 }
        },
        audio: false
      });
    } catch (_) {
      // 2. Simple fallback: request any available camera
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      } catch (fallbackErr) {
        throw this.formatError(fallbackErr);
      }
    }

    this.stream = stream;
    this.videoElement.srcObject = stream;

    // Safely start video playback
    try {
      await this.videoElement.play();
    } catch (_) {
      // Autoplay may wait for user gesture; safely handled
    }

    this.checkCapabilities();
    return true;
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
   * Captures the current video frame onto a canvas at native video resolution
   * @param {HTMLCanvasElement} [targetCanvas]
   * @returns {HTMLCanvasElement}
   */
  captureFrame(targetCanvas = null) {
    if (!this.videoElement || !this.stream) {
      throw new Error('Camera is not active.');
    }

    const video = this.videoElement;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

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
