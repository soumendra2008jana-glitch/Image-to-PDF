"""
WebScan PDF Generator Service
Losslessly converts image streams into multi-page PDF documents using img2pdf and Pillow.
Supports target PDF file size constraint (in KBs and MBs) with adaptive image optimization.
"""

import io
from PIL import Image, ImageOps
import img2pdf

# Security hardening: Prevent decompression bombs by limiting max image pixels to 100 Megapixels
# 100 megapixels comfortably accommodates high-resolution smartphone cameras (48MP, 50MP, 64MP)
# while blocking true decompression bombs (hundreds of millions / billions of pixels).
Image.MAX_IMAGE_PIXELS = 100_000_000

# Constants for security limits
MAX_IMAGES_PER_PDF = 50
MAX_SINGLE_IMAGE_BYTES = 30 * 1024 * 1024  # 30 MB per raw image
ALLOWED_FORMATS = {'JPEG', 'PNG', 'WEBP', 'TIFF', 'BMP'}
VALID_PAGE_SIZES = {'A4', 'US_Letter', 'Fit'}
VALID_ORIENTATIONS = {'auto', 'portrait', 'landscape'}
MAX_DOCUMENT_DIMENSION = 3840  # 4K resolution preserves razor-sharp text clarity


def normalize_image_to_jpeg_bytes(image_data, quality=98, max_dimension=None):
    """
    Ensures the image is in RGB format, optionally resizes if exceeding max_dimension,
    and returns high-fidelity JPEG bytes with 4:4:4 chroma subsampling (no color subsampling).
    Validates image integrity and protects against decompression bombs and corrupt streams.
    """
    try:
        if isinstance(image_data, bytes):
            if len(image_data) > MAX_SINGLE_IMAGE_BYTES:
                raise ValueError(f"Image exceeds maximum size limit of {MAX_SINGLE_IMAGE_BYTES // (1024 * 1024)} MB.")
            image_stream = io.BytesIO(image_data)
        else:
            image_stream = image_data

        try:
            with Image.open(image_stream) as img:
                # Explicit pixel dimension check to prevent decompression bombs (ZIP/Pixel bombs)
                total_pixels = img.size[0] * img.size[1]
                if total_pixels > Image.MAX_IMAGE_PIXELS:
                    raise ValueError(f"Image resolution ({img.size[0]}x{img.size[1]} = {total_pixels} pixels) exceeds safety limit of {Image.MAX_IMAGE_PIXELS} pixels (potential decompression bomb).")

                # Validate image format against allowlist
                if img.format and img.format.upper() not in ALLOWED_FORMATS:
                    raise ValueError(f"Unsupported image format '{img.format}'. Allowed: JPG, PNG, WEBP, TIFF, BMP.")

                # Handle EXIF orientation if present
                try:
                    img = ImageOps.exif_transpose(img)
                except Exception:
                    pass

                # Convert RGBA, P, or LA to pure RGB
                if img.mode in ('RGBA', 'LA', 'P'):
                    rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    rgb_img.paste(img, mask=img.split()[3] if 'A' in img.mode else None)
                    img = rgb_img
                elif img.mode != 'RGB':
                    img = img.convert('RGB')

                # Automatically downscale if max_dimension is requested, or if image exceeds 4K document size (3840px)
                effective_max_dim = max_dimension or MAX_DOCUMENT_DIMENSION
                if max(img.size) > effective_max_dim:
                    img.thumbnail((effective_max_dim, effective_max_dim), Image.Resampling.LANCZOS)

                output_io = io.BytesIO()
                # Use subsampling=0 (4:4:4 chroma subsampling) to prevent color subsampling and blurry text edges
                img.save(
                    output_io,
                    format='JPEG',
                    quality=quality,
                    subsampling=0,
                    optimize=True,
                    dpi=(300, 300)
                )
                return output_io.getvalue()
        except Image.DecompressionBombError:
            raise ValueError("Image resolution is excessively large (potential decompression bomb).")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Failed to process image: {str(e)}")


def get_layout_function(page_size='A4', orientation='auto'):
    """Returns the img2pdf layout function based on page size and orientation."""
    if page_size == 'Fit':
        return None

    if page_size == 'US_Letter':
        base_w = img2pdf.in_to_pt(8.5)
        base_h = img2pdf.in_to_pt(11.0)
    else:
        # Default A4
        base_w = img2pdf.mm_to_pt(210)
        base_h = img2pdf.mm_to_pt(297)

    if orientation == 'landscape':
        pw, ph = max(base_w, base_h), min(base_w, base_h)
        return img2pdf.get_layout_fun(pagesize=(pw, ph), fit=img2pdf.FitMode.into)
    elif orientation == 'portrait':
        pw, ph = min(base_w, base_h), max(base_w, base_h)
        return img2pdf.get_layout_fun(pagesize=(pw, ph), fit=img2pdf.FitMode.into)
    else:
        # Auto orientation per page
        def auto_layout(imgwidthpx, imgheightpx, ndpi):
            if imgwidthpx > imgheightpx:
                pw, ph = max(base_w, base_h), min(base_w, base_h)
            else:
                pw, ph = min(base_w, base_h), max(base_w, base_h)
            layout_fn = img2pdf.get_layout_fun(pagesize=(pw, ph), fit=img2pdf.FitMode.into)
            return layout_fn(imgwidthpx, imgheightpx, ndpi)

        return auto_layout


def compile_pdf_bytes(jpeg_images, layout_fun):
    """Compiles list of JPEG byte buffers into raw PDF bytes."""
    if layout_fun:
        return img2pdf.convert(jpeg_images, layout_fun=layout_fun)
    return img2pdf.convert(jpeg_images)


def create_pdf_from_images(image_list, page_size='A4', orientation='auto', target_size_kb=None):
    """
    Compiles a sequence of images into a single multi-page PDF document.
    If target_size_kb is specified, adaptively optimizes image quality/resolution
    to stay within the requested target file size.

    :param image_list: List of image bytes or file-like objects
    :param page_size: 'A4', 'US_Letter', or 'Fit'
    :param orientation: 'auto', 'portrait', or 'landscape'
    :param target_size_kb: Optional target maximum PDF size in Kilobytes (e.g., 500, 2048)
    :return: io.BytesIO containing the compiled PDF
    """
    if not image_list:
        raise ValueError("No images provided for PDF compilation.")

    if len(image_list) > MAX_IMAGES_PER_PDF:
        raise ValueError(f"Too many images. Maximum allowed pages per document is {MAX_IMAGES_PER_PDF}.")

    # Parameter normalization and whitelist validation
    page_size = page_size if page_size in VALID_PAGE_SIZES else 'A4'
    orientation = orientation if orientation in VALID_ORIENTATIONS else 'auto'

    # Validate target_size_kb bounds
    if target_size_kb is not None:
        try:
            target_size_kb = int(target_size_kb)
            if target_size_kb < 10:
                target_size_kb = 10
            elif target_size_kb > 100_000:
                target_size_kb = 100_000
        except (ValueError, TypeError):
            target_size_kb = None

    # Cache raw image bytes
    raw_images = []
    for img_item in image_list:
        if hasattr(img_item, 'read'):
            raw_bytes = img_item.read()
        else:
            raw_bytes = img_item

        if len(raw_bytes) > MAX_SINGLE_IMAGE_BYTES:
            raise ValueError(f"Single image exceeds maximum allowed size of {MAX_SINGLE_IMAGE_BYTES // (1024 * 1024)} MB.")
        raw_images.append(raw_bytes)

    layout_fun = get_layout_function(page_size, orientation)

    # 1. Generate standard maximum-quality baseline PDF (quality 98, 4:4:4 chroma subsampling)
    baseline_images = [
        normalize_image_to_jpeg_bytes(img, quality=98, max_dimension=None)
        for img in raw_images
    ]
    baseline_pdf_bytes = compile_pdf_bytes(baseline_images, layout_fun)

    # If no target size is requested, or baseline already fits within target, return baseline
    target_bytes = target_size_kb * 1024 if (target_size_kb and target_size_kb > 0) else None
    if not target_bytes or len(baseline_pdf_bytes) <= target_bytes:
        buffer = io.BytesIO(baseline_pdf_bytes)
        buffer.seek(0)
        return buffer

    # 2. Adaptive compression to meet target file size
    # Candidate profiles ordered from highest visual fidelity to maximum compression
    compression_profiles = [
        (95, 3200),
        (88, 2600),
        (80, 2200),
        (70, 1800),
        (60, 1500),
        (50, 1300),
        (40, 1100),
        (30, 900),
        (22, 750),
        (18, 600)
    ]

    selected_pdf_bytes = None

    for quality, max_dim in compression_profiles:
        trial_images = [
            normalize_image_to_jpeg_bytes(img, quality=quality, max_dimension=max_dim)
            for img in raw_images
        ]
        trial_pdf_bytes = compile_pdf_bytes(trial_images, layout_fun)

        if len(trial_pdf_bytes) <= target_bytes:
            selected_pdf_bytes = trial_pdf_bytes
            break
        else:
            # Keep smallest so far if target is unusually low
            selected_pdf_bytes = trial_pdf_bytes

    final_pdf_bytes = selected_pdf_bytes or baseline_pdf_bytes
    pdf_buffer = io.BytesIO(final_pdf_bytes)
    pdf_buffer.seek(0)
    return pdf_buffer
