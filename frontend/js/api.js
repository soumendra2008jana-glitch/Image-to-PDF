/**
 * WebScan - API Client Module
 * Communicates with the Flask backend API for health checks and PDF compilation.
 */

class ApiService {
  constructor(baseUrl = '') {
    if (baseUrl) {
      this.baseUrl = baseUrl.replace(/\/$/, '');
    } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      // Local development environment
      if (window.location.port === '5000' || window.location.port === '5001') {
        this.baseUrl = window.location.origin;
      } else {
        const isHttps = window.location.protocol === 'https:';
        const defaultPort = isHttps ? '5001' : '5000';
        this.baseUrl = `${window.location.protocol}//${window.location.hostname}:${defaultPort}`;
      }
    } else {
      // Production deployment (Render, custom domain, etc.): use same-origin
      this.baseUrl = window.location.origin;
    }
    this.isBackendOnline = false;
  }

  /**
   * Sets backend API base URL
   */
  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  /**
   * Pings backend server to verify health status
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const response = await fetch(`${this.baseUrl}/ping`, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      this.isBackendOnline = response.ok;
      return this.isBackendOnline;
    } catch (err) {
      this.isBackendOnline = false;
      return false;
    }
  }

  /**
   * Sends scanned pages to backend to compile into a multi-page PDF
   * @param {Array<{blob: Blob, dataUrl: string}>} pages
   * @param {Object} options - { filename, pageSize, orientation }
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async generatePdf(pages, options = {}) {
    if (!pages || pages.length === 0) {
      throw new Error('No pages available to generate PDF.');
    }

    let filename = (options.filename || 'Scanned_Document').trim();
    // Strip control characters, quotes, and path traversal
    filename = filename
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .replace(/\.\./g, '')
      .replace(/[/\\?%*:|"<>`';]/g, '_')
      .replace(/^[._\s]+|[._\s]+$/g, '')
      .substring(0, 80);
    filename = filename || 'Scanned_Document';

    const pageSize = ['A4', 'US_Letter', 'Fit'].includes(options.pageSize) ? options.pageSize : 'A4';
    const orientation = ['auto', 'portrait', 'landscape'].includes(options.orientation) ? options.orientation : 'auto';

    // Prepare FormData payload
    const formData = new FormData();
    formData.append('filename', filename);
    formData.append('page_size', pageSize);
    formData.append('orientation', orientation);

    if (options.targetSizeValue) {
      formData.append('target_size_value', options.targetSizeValue);
      formData.append('target_size_unit', options.targetSizeUnit || 'KB');
    }

    pages.forEach((page, index) => {
      const blob = page.blob;
      const pageNum = String(index + 1).padStart(3, '0');
      const ext = blob && blob.type === 'image/png' ? 'png' : 'jpg';
      formData.append('images', blob, `page_${pageNum}.${ext}`);
    });

    try {
      const response = await fetch(`${this.baseUrl}/api/generate-pdf`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        let errDetail = 'Failed to generate PDF';
        try {
          const errJson = await response.json();
          errDetail = errJson.error || errDetail;
        } catch (e) {
          errDetail = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errDetail);
      }

      // Read PDF binary blob
      const pdfBlob = await response.blob();

      // Trigger browser download
      this.downloadBlob(pdfBlob, `${filename}.pdf`);

      return { success: true };
    } catch (err) {
      console.error('API generate-pdf error:', err);
      throw err;
    }
  }

  /**
   * Helper to trigger native browser file download from Blob
   * @param {Blob} blob
   * @param {string} fileName
   */
  downloadBlob(blob, fileName) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    }, 200);
  }
}

// Export singleton instance
window.apiService = new ApiService();
