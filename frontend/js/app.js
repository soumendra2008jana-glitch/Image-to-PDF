/**
 * WebScan - Main Application Orchestrator
 * Connects Camera, Cropper, Filters, Gallery, and API modules into a unified workflow.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Global Application State
  const state = {
    currentScreen: 'capture',
    pages: [], // Array of { id, dataUrl, blob, timestamp }
    currentRawImage: null, // Image or Canvas from camera/upload before crop
    warpedCanvas: null, // Canvas after perspective warp
    filterPreset: 'original',
    brightness: 0,
    contrast: 0,
    isOpenCvReady: false,
    batchQueue: [] // Remaining files to process if user dropped multiple files
  };

  // DOM Elements Cache
  const screens = {
    capture: document.getElementById('screen-capture'),
    crop: document.getElementById('screen-crop'),
    filter: document.getElementById('screen-filter'),
    gallery: document.getElementById('screen-gallery')
  };


  const videoElement = document.getElementById('camera-stream');
  const cameraPlaceholder = document.getElementById('camera-placeholder');
  const btnRequestCamera = document.getElementById('btn-request-camera');
  const btnNativeCamera = document.getElementById('btn-native-camera');
  const cameraNativeInput = document.getElementById('camera-native-input');
  const cameraStatusMsg = document.getElementById('camera-status-msg');
  const cameraSecureHint = document.getElementById('camera-secure-hint');
  const btnToggleCamera = document.getElementById('btn-toggle-camera');
  const btnToggleTorch = document.getElementById('btn-toggle-torch');
  const btnShutter = document.getElementById('btn-shutter');

  const fileInput = document.getElementById('file-input');
  const uploadDropzone = document.getElementById('upload-dropzone');
  const btnSelectFile = document.getElementById('btn-select-file');

  const headerPageCount = document.getElementById('header-page-count');
  const shutterPageCount = document.getElementById('shutter-page-count');
  const btnHeaderGallery = document.getElementById('btn-header-gallery');
  const btnOpenGallery = document.getElementById('btn-open-gallery');

  // Crop Screen DOM
  const cropWorkspace = document.getElementById('crop-workspace');
  const cropCanvasWrapper = document.getElementById('crop-canvas-wrapper');
  const cropCanvas = document.getElementById('crop-canvas');
  const cropSvgOverlay = document.getElementById('crop-svg-overlay');
  const cropPolygon = document.getElementById('crop-polygon');
  const cropLoupe = document.getElementById('crop-loupe');
  const loupeCanvas = document.getElementById('loupe-canvas');
  const btnAutoDetect = document.getElementById('btn-auto-detect');
  const btnDetectContent = document.getElementById('btn-detect-content');
  const btnResetCrop = document.getElementById('btn-reset-crop');
  const btnRotateCapture = document.getElementById('btn-rotate-capture');
  const btnCancelCrop = document.getElementById('btn-cancel-crop');
  const btnApplyCrop = document.getElementById('btn-apply-crop');

  // Filter Screen DOM
  const filterCanvas = document.getElementById('filter-canvas');
  const filterSpinner = document.getElementById('filter-processing-spinner');
  const presetButtons = document.querySelectorAll('.preset-btn');
  const sliderBrightness = document.getElementById('slider-brightness');
  const sliderContrast = document.getElementById('slider-contrast');
  const valBrightness = document.getElementById('val-brightness');
  const valContrast = document.getElementById('val-contrast');
  const btnRotateWarped = document.getElementById('btn-rotate-warped');
  const btnBackToCrop = document.getElementById('btn-back-to-crop');
  const btnSavePage = document.getElementById('btn-save-page');

  // Gallery Screen DOM
  const pagesGrid = document.getElementById('pages-grid');
  const galleryEmptyState = document.getElementById('gallery-empty-state');
  const galleryTotalCount = document.getElementById('gallery-total-count');
  const exportSummaryText = document.getElementById('export-summary-text');
  const docFilename = document.getElementById('doc-filename');
  const pdfPageSize = document.getElementById('pdf-page-size');
  const pdfOrientation = document.getElementById('pdf-orientation');
  const pdfTargetSizeValue = document.getElementById('pdf-target-size-value');
  const pdfTargetSizeUnit = document.getElementById('pdf-target-size-unit');
  const sizeChips = document.querySelectorAll('.size-chip');
  const btnAddMoreCamera = document.getElementById('btn-add-more-camera');
  const btnAddMoreUpload = document.getElementById('btn-add-more-upload');
  const btnEmptyCamera = document.getElementById('btn-empty-camera');
  const btnEmptyUpload = document.getElementById('btn-empty-upload');
  const btnClearAll = document.getElementById('btn-clear-all');
  const btnGeneratePdf = document.getElementById('btn-generate-pdf');

  const toastContainer = document.getElementById('toast-container');

  // =========================================================================
  // Toast Notification System
  // =========================================================================
  function showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle-2';
    if (type === 'error') iconName = 'alert-triangle';

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', iconName);

    const messageSpan = document.createElement('span');
    messageSpan.textContent = String(message || '');

    toast.appendChild(icon);
    toast.appendChild(messageSpan);

    toastContainer.appendChild(toast);
    if (window.lucide) lucide.createIcons({ root: toast });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(16px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // =========================================================================
  // OpenCV.js Initialization & Monitoring
  // =========================================================================
  function monitorOpenCV() {
    if (window.isOpenCvReady || (window.cv && window.cv.Mat)) {
      onOpenCvReady();
      return;
    }

    const prevInit = window.Module && window.Module.onRuntimeInitialized;
    window.Module = window.Module || {};
    window.Module.onRuntimeInitialized = () => {
      if (typeof prevInit === 'function') prevInit();
      onOpenCvReady();
    };

    // Polling fallback
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (window.isOpenCvReady || (window.cv && window.cv.Mat)) {
        clearInterval(interval);
        onOpenCvReady();
      } else if (attempts > 60) {
        clearInterval(interval);
      }
    }, 200);
  }

  function onOpenCvReady() {
    state.isOpenCvReady = true;
  }

  // =========================================================================
  // Screen Navigation Management
  // =========================================================================
  function switchScreen(targetScreenName) {
    Object.keys(screens).forEach((name) => {
      if (name === targetScreenName) {
        screens[name].classList.add('active');
      } else {
        screens[name].classList.remove('active');
      }
    });

    state.currentScreen = targetScreenName;

    // Manage camera lifecycle
    if (targetScreenName === 'capture') {
      startCameraFeed();
    } else {
      window.cameraController.stopCamera();
    }

    if (targetScreenName === 'gallery') {
      renderGallery();
    }

    // Re-initialize Lucide icons in newly active screen
    if (window.lucide) {
      lucide.createIcons();
    }
  }

  // =========================================================================
  // Camera Management
  // =========================================================================
  function updateSecureHint() {
    if (!cameraSecureHint) return;
    const { isSecure } = window.cameraController.getSecurityContext();
    if (!isSecure) {
      cameraSecureHint.innerHTML = `<i data-lucide="shield-alert"></i> Web browsers require HTTPS for live camera feeds over Wi-Fi. Tap <strong>Take Photo with Phone Camera</strong> to scan directly.`;
    } else {
      cameraSecureHint.innerHTML = `<i data-lucide="info"></i> Tap the lock icon (🔒) in your browser's address bar to Allow camera access.`;
    }
    if (window.lucide) lucide.createIcons({ root: cameraSecureHint });
  }

  async function startCameraFeed(userInitiated = false) {
    if (!window.cameraController.isSupported()) {
      cameraPlaceholder.classList.remove('hidden');
      if (cameraStatusMsg) {
        const { isSecure } = window.cameraController.getSecurityContext();
        cameraStatusMsg.textContent = isSecure
          ? 'Camera is not supported on this browser.'
          : 'Live camera requires HTTPS or localhost.';
      }
      updateSecureHint();
      return;
    }

    try {
      await window.cameraController.startCamera(videoElement);
      cameraPlaceholder.classList.add('hidden');
      if (window.cameraController.hasTorch) {
        btnToggleTorch.classList.remove('hidden');
      } else {
        btnToggleTorch.classList.add('hidden');
      }
    } catch (err) {
      cameraPlaceholder.classList.remove('hidden');
      if (cameraStatusMsg) {
        cameraStatusMsg.textContent = err.message || 'Camera is inactive';
      }
      updateSecureHint();
      if (userInitiated) {
        showToast(err.message || 'Could not access camera.', 'info');
      }
    }
  }

  btnRequestCamera.addEventListener('click', () => startCameraFeed(true));

  if (cameraNativeInput) {
    cameraNativeInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        const blobUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(blobUrl);
          cameraNativeInput.value = '';
          loadCapturedImageToCrop(canvas);
        };
        img.onerror = (err) => {
          console.error('Failed decoding mobile camera image:', err);
          URL.revokeObjectURL(blobUrl);
          cameraNativeInput.value = '';
          showToast('Could not load captured photo. Please try again.', 'error');
        };
        img.src = blobUrl;
      }
    });
  }

  btnToggleCamera.addEventListener('click', async () => {
    try {
      await window.cameraController.switchCamera();
    } catch (err) {
      showToast('Could not switch camera.', 'error');
    }
  });

  btnToggleTorch.addEventListener('click', async () => {
    const isOn = await window.cameraController.toggleTorch();
    btnToggleTorch.style.color = isOn ? '#f59e0b' : '#ffffff';
  });

  // Shutter action: captures live frame when camera active, or guides user to enable camera/upload
  btnShutter.addEventListener('click', async () => {
    if (window.cameraController.isActive()) {
      if (navigator.vibrate) {
        try { navigator.vibrate(30); } catch (_) {}
      }
      try {
        btnShutter.disabled = true;
        const capturedCanvas = await window.cameraController.captureFrame();
        loadCapturedImageToCrop(capturedCanvas);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnShutter.disabled = false;
      }
    } else {
      // Live camera is inactive: inform user cleanly without triggering unactivated file chooser warnings
      showToast('Live camera is not active. Click "Start Live Camera" or select a file to scan.', 'info');
    }
  });

  // =========================================================================
  // File Upload & Drag and Drop Handling
  // =========================================================================
  btnSelectFile.addEventListener('click', () => fileInput.click());
  uploadDropzone.addEventListener('click', () => fileInput.click());

  uploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropzone.classList.add('drag-active');
  });

  uploadDropzone.addEventListener('dragleave', () => {
    uploadDropzone.classList.remove('drag-active');
  });

  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('drag-active');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  });

  function handleFiles(files) {
    const validImages = files.filter(f => f.type.startsWith('image/'));
    if (validImages.length === 0) {
      showToast('Please select valid image files (JPG, PNG, WEBP).', 'error');
      return;
    }

    state.batchQueue = validImages;
    processNextInBatch();
  }

  function processNextInBatch() {
    if (!state.batchQueue || state.batchQueue.length === 0) return;

    const file = state.batchQueue.shift();
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        loadCapturedImageToCrop(img);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // =========================================================================
  // Cropper Workspace Initialization & Actions
  // =========================================================================
  window.cropperManager.init({
    canvas: cropCanvas,
    workspace: cropWorkspace,
    wrapper: cropCanvasWrapper,
    svgOverlay: cropSvgOverlay,
    polygon: cropPolygon,
    loupe: cropLoupe,
    loupeCanvas: loupeCanvas,
    handles: {
      tl: document.getElementById('corner-tl'),
      tr: document.getElementById('corner-tr'),
      br: document.getElementById('corner-br'),
      bl: document.getElementById('corner-bl')
    }
  });

  function loadCapturedImageToCrop(imageOrCanvas) {
    state.currentRawImage = imageOrCanvas;
    switchScreen('crop');
    // Allow layout reflow on newly active crop screen before measuring workspace
    requestAnimationFrame(() => {
      window.cropperManager.loadSource(imageOrCanvas);
    });
  }

  btnAutoDetect.addEventListener('click', () => {
    window.cropperManager.userHasManuallyAdjusted = false;
    const res = window.cropperManager.autoDetectCorners();
    if (res && res.type === 'document') {
      showToast('Document boundary detected.', 'success', 1500);
    } else if (res && res.type === 'content') {
      showToast('Document content detected.', 'success', 1500);
    } else {
      showToast('Auto-crop applied.', 'success', 1500);
    }
  });

  if (btnDetectContent) {
    btnDetectContent.addEventListener('click', () => {
      window.cropperManager.userHasManuallyAdjusted = false;
      const res = window.cropperManager.detectSalientContent();
      if (res && res.corners) {
        showToast('Cropped to document content.', 'success', 1500);
      } else {
        showToast('Document content framed.', 'info', 1500);
      }
    });
  }

  btnResetCrop.addEventListener('click', () => {
    window.cropperManager.resetToFullImage();
  });

  btnRotateCapture.addEventListener('click', () => {
    window.cropperManager.rotateSource();
  });

  btnCancelCrop.addEventListener('click', () => {
    switchScreen('capture');
  });

  btnApplyCrop.addEventListener('click', () => {
    try {
      const warped = window.cropperManager.warpDocument();
      state.warpedCanvas = warped;
      loadWarpedToFilter(warped);
    } catch (err) {
      showToast(err.message || 'Error warping document.', 'error');
    }
  });

  // =========================================================================
  // Filter & Enhancement Workspace Actions
  // =========================================================================
  function loadWarpedToFilter(canvas) {
    switchScreen('filter');
    window.filterManager.init(canvas, filterCanvas);

    // Reset presets and sliders
    state.filterPreset = 'original';
    state.brightness = 0;
    state.contrast = 0;

    sliderBrightness.value = '0';
    sliderContrast.value = '0';
    valBrightness.textContent = '0';
    valContrast.textContent = '0';

    presetButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === 'original');
    });

    window.filterManager.apply('original', 0, 0);
  }

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      state.filterPreset = btn.dataset.preset;
      filterSpinner.classList.remove('hidden');

      // Async timeout so UI shows spinner
      setTimeout(() => {
        window.filterManager.apply(state.filterPreset, state.brightness, state.contrast);
        filterSpinner.classList.add('hidden');
      }, 20);
    });
  });

  let rafId = null;
  function updateSliders() {
    state.brightness = parseInt(sliderBrightness.value, 10);
    state.contrast = parseInt(sliderContrast.value, 10);
    valBrightness.textContent = state.brightness;
    valContrast.textContent = state.contrast;

    // Use requestAnimationFrame with coalescing for buttery smooth 60fps/120fps updates
    if (rafId) {
      cancelAnimationFrame(rafId);
    }
    rafId = requestAnimationFrame(() => {
      window.filterManager.adjustBrightnessContrast(state.brightness, state.contrast);
      rafId = null;
    });
  }

  sliderBrightness.addEventListener('input', updateSliders);
  sliderContrast.addEventListener('input', updateSliders);

  btnRotateWarped.addEventListener('click', () => {
    window.filterManager.rotateWarped();
  });

  btnBackToCrop.addEventListener('click', () => {
    switchScreen('crop');
    requestAnimationFrame(() => {
      window.cropperManager.renderDisplay();
    });
  });

  btnSavePage.addEventListener('click', async () => {
    const dataUrl = window.filterManager.getFilteredDataURL(0.98);
    const blob = await window.filterManager.getFilteredBlob(0.98);

    const newPage = {
      id: 'page_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      dataUrl,
      blob,
      timestamp: Date.now()
    };

    state.pages.push(newPage);
    updatePageCounters();
    showToast(`Page ${state.pages.length} added to document!`, 'success');

    // If there are more images in the batch upload queue, process next
    if (state.batchQueue && state.batchQueue.length > 0) {
      processNextInBatch();
    } else {
      switchScreen('gallery');
    }
  });

  // =========================================================================
  // Gallery & PDF Export Actions
  // =========================================================================
  function updatePageCounters() {
    const count = state.pages.length;
    headerPageCount.textContent = count;
    shutterPageCount.textContent = count;
    galleryTotalCount.textContent = count;
    exportSummaryText.textContent = `Ready to compile ${count} page${count === 1 ? '' : 's'}`;
  }

  function renderGallery() {
    updatePageCounters();
    pagesGrid.innerHTML = '';

    if (state.pages.length === 0) {
      galleryEmptyState.classList.add('active');
      pagesGrid.classList.add('hidden');
      return;
    }

    galleryEmptyState.classList.remove('active');
    pagesGrid.classList.remove('hidden');

    state.pages.forEach((page, index) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.innerHTML = `
        <div class="page-thumb-container">
          <img src="${page.dataUrl}" alt="Scanned Page ${index + 1}" class="page-thumb-img">
          <div class="page-badge-num">Page ${index + 1}</div>
        </div>
        <div class="page-card-actions">
          <div class="page-reorder-btns">
            <button class="btn-page-action btn-move-left" title="Move Left/Up" ${index === 0 ? 'disabled style="opacity:0.3"' : ''}>
              <i data-lucide="chevron-left"></i>
            </button>
            <button class="btn-page-action btn-move-right" title="Move Right/Down" ${index === state.pages.length - 1 ? 'disabled style="opacity:0.3"' : ''}>
              <i data-lucide="chevron-right"></i>
            </button>
          </div>
          <button class="btn-page-action delete btn-delete-page" title="Delete page">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      `;

      // Event handlers for page card
      const btnMoveLeft = card.querySelector('.btn-move-left');
      const btnMoveRight = card.querySelector('.btn-move-right');
      const btnDelete = card.querySelector('.btn-delete-page');

      if (btnMoveLeft && index > 0) {
        btnMoveLeft.addEventListener('click', () => {
          const temp = state.pages[index - 1];
          state.pages[index - 1] = state.pages[index];
          state.pages[index] = temp;
          renderGallery();
        });
      }

      if (btnMoveRight && index < state.pages.length - 1) {
        btnMoveRight.addEventListener('click', () => {
          const temp = state.pages[index + 1];
          state.pages[index + 1] = state.pages[index];
          state.pages[index] = temp;
          renderGallery();
        });
      }

      btnDelete.addEventListener('click', () => {
        state.pages.splice(index, 1);
        renderGallery();
        showToast('Page deleted.', 'info');
      });

      pagesGrid.appendChild(card);
    });

    if (window.lucide) {
      lucide.createIcons({ root: pagesGrid });
    }
  }

  btnHeaderGallery.addEventListener('click', () => switchScreen('gallery'));
  btnOpenGallery.addEventListener('click', () => switchScreen('gallery'));

  btnAddMoreCamera.addEventListener('click', () => switchScreen('capture'));
  btnEmptyCamera.addEventListener('click', () => switchScreen('capture'));

  btnAddMoreUpload.addEventListener('click', () => fileInput.click());
  btnEmptyUpload.addEventListener('click', () => fileInput.click());

  btnClearAll.addEventListener('click', () => {
    if (state.pages.length === 0) return;
    if (confirm('Are you sure you want to delete all scanned pages?')) {
      state.pages = [];
      renderGallery();
      showToast('All pages cleared.', 'info');
    }
  });

  // Size Preset Chips handling
  if (sizeChips) {
    sizeChips.forEach(chip => {
      chip.addEventListener('click', () => {
        sizeChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const val = chip.dataset.val;
        const unit = chip.dataset.unit;
        if (pdfTargetSizeValue) pdfTargetSizeValue.value = val;
        if (pdfTargetSizeUnit) pdfTargetSizeUnit.value = unit;
      });
    });
  }

  if (pdfTargetSizeValue) {
    pdfTargetSizeValue.addEventListener('input', () => {
      sizeChips.forEach(c => c.classList.remove('active'));
    });
  }

  // PDF Generation Action
  btnGeneratePdf.addEventListener('click', async () => {
    if (state.pages.length === 0) {
      showToast('Scan or upload at least one page first!', 'error');
      return;
    }

    const filename = docFilename.value || 'Scanned_Document';
    const pageSize = pdfPageSize.value;
    const orientation = pdfOrientation.value;
    const targetSizeValue = pdfTargetSizeValue ? pdfTargetSizeValue.value.trim() : '';
    const targetSizeUnit = pdfTargetSizeUnit ? pdfTargetSizeUnit.value : 'KB';

    btnGeneratePdf.disabled = true;
    btnGeneratePdf.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block"></div> Generating PDF...`;

    try {
      await window.apiService.generatePdf(state.pages, {
        filename,
        pageSize,
        orientation,
        targetSizeValue,
        targetSizeUnit
      });
      showToast('PDF successfully compiled and downloaded!', 'success');
    } catch (err) {
      console.warn('Backend generation failed:', err);
      const isNetworkErr = !err.message ||
        err.message.toLowerCase().includes('failed to fetch') ||
        err.message.toLowerCase().includes('networkerror');
      const errorMsg = isNetworkErr
        ? 'Cannot connect to backend server. Please verify the Python server is running at http://localhost:5000.'
        : err.message;
      showToast(errorMsg, 'error', 6000);
    } finally {
      btnGeneratePdf.disabled = false;
      btnGeneratePdf.innerHTML = `<i data-lucide="download"></i> Generate & Download PDF`;
      if (window.lucide) lucide.createIcons({ root: btnGeneratePdf });
    }
  });

  // Initialize OpenCV monitoring
  monitorOpenCV();

  // Switch to initial capture view
  switchScreen('capture');
});
