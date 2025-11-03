(function() {
  const root = document.getElementById('ewz-cropper-block');
  if (!root) return;

  // --- DATA FROM LIQUID
  const endpoint = root.dataset.endpoint;
  const moneyFormat = root.dataset.moneyFormat;
  const currencyISO = root.dataset.currency;
  const defaultUnit = root.dataset.defaultUnit || 'in';
  const minAreaFt2 = Number(root.dataset.minArea || 30);
  const enablePanels = root.dataset.enablePanels === 'true';
  const panelTarget = Number(root.dataset.panelTarget || 24);
  const panelMax = Number(root.dataset.panelMax || 25);

  // Prices: "variantId:cents,variantId:cents"
  const varPriceMap = {};
  (root.dataset.variantPrices || '').split(',').forEach(pair => {
    const [id, cents] = pair.split(':');
    if (id && cents) varPriceMap[id] = Number(cents);
  });

  // Inputs & elements
  const $open = root.querySelector('.ewz-open');
  const $modal = root.querySelector('.ewz-modal');
  const $close = root.querySelector('.ewz-close');
  const $width = root.querySelector('#ewz-width');
  const $height = root.querySelector('#ewz-height');
  const $unit = root.querySelector('#ewz-unit');
  const $area = root.querySelector('#ewz-area');
  const $total = root.querySelector('#ewz-total');
  const $minwarn = root.querySelector('#ewz-minwarn');
  const $add = root.querySelector('.ewz-add');
  const $panelsToggle = root.querySelector('#ewz-panels');

  // Currency formatter using the shop's money format
  function formatMoney(cents) {
    // Basic formatter using Shopify money_format string from Liquid
    const value = (cents / 100).toFixed(2);
    return moneyFormat
      .replace(/{{\s*amount_with_comma_separator\s*}}|{{\s*amount_no_decimals\s*}}|{{\s*amount\s*}}/g, value)
      .replace(/{{\s*shop\.currency\s*}}/g, currencyISO)
      .replace(/{{\s*currency\s*}}/g, currencyISO)
      .replace(/{{\s*amount_no_decimals_with_comma_separator\s*}}/g, Math.round(cents / 100));
  }

  // Unit helpers
  const cmToIn = cm => cm / 2.54;
  const inToCm = inch => inch * 2.54;
  const inToFt2 = (w, h) => (w * h) / 144;

  function getDimsInInches() {
    const w = Number($width.value || 0);
    const h = Number($height.value || 0);
    if ($unit.value === 'cm') return { wIn: cmToIn(w), hIn: cmToIn(h) };
    return { wIn: w, hIn: h };
  }

  // Variant detection (listen to theme's variant change if available)
  let selectedVariantId = root.dataset.variantId;
  const variantSelect = document.querySelector('form[action*="/cart/add"] [name="id"], #product-form [name="id"], [data-product-form] [name="id"]');
  if (variantSelect) {
    selectedVariantId = variantSelect.value || selectedVariantId;
    variantSelect.addEventListener('change', () => {
      selectedVariantId = variantSelect.value;
      updatePriceView();
    });
  }

  // Modal open/close
  function openModal() {
    $modal.setAttribute('aria-hidden', 'false');
    setTimeout(initCanvasOnce, 0);
  }
  function closeModal() {
    $modal.setAttribute('aria-hidden', 'true');
  }
  $open?.addEventListener('click', openModal);
  $close?.addEventListener('click', closeModal);
  $modal?.addEventListener('click', (e) => { if (e.target === $modal) closeModal(); });

  // Canvas / Fabric init
  let canvas, baseImg, cropRect;
  let panelLines = []; // Fabric.Line[]
  let overlayFuncBound = null;

  const canvasEl = document.getElementById('ewz-canvas');

  // pick the 2nd product image as the preview source
  function pickSecondImageUrl() {
    // Try to find from PDP DOM first (safer with different themes)
    const galleryImgs = document.querySelectorAll('[data-product-media] img, .product__media img, img[src*="/products/"]');
    // Filter to unique product images (not thumbnails)
    const urls = [];
    galleryImgs.forEach(img => {
      if (!img.src) return;
      if (!urls.includes(img.src)) urls.push(img.src);
    });
    if (urls.length >= 2) return urls[1]; // second image
    // Fallback: use first if second not found
    return urls[0] || '';
  }

  function setCanvasSize() {
    const wrap = canvasEl.parentElement.getBoundingClientRect();
    canvas.setWidth(wrap.width);
    canvas.setHeight(wrap.height);
    canvas.renderAll();
  }

  function initCanvasOnce() {
    if (canvas) { setCanvasSize(); return; }
    canvas = new fabric.Canvas(canvasEl, { selection: false, preserveObjectStacking: true });

    window.addEventListener('resize', setCanvasSize);

    const srcUrl = pickSecondImageUrl();
    if (!srcUrl) {
      console.warn('No product image found');
      return;
    }

    fabric.Image.fromURL(srcUrl, (img) => {
      baseImg = img;
      baseImg.selectable = false;
      baseImg.evented = false;

      setCanvasSize();

      // Fit image into canvas without allowing zoom (scale once)
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      baseImg.scale(scale);
      baseImg.set({
        left: (canvas.width - img.width * scale)/2,
        top: (canvas.height - img.height * scale)/2
      });
      canvas.add(baseImg);

      initCropRect();
      bindUI();
      updateEverything();
    }, { crossOrigin: 'anonymous' });
  }

  function initCropRect() {
    const { wIn, hIn } = getDimsInInches();
    const ratio = (wIn && hIn) ? (wIn / hIn) : 1;

    let rectW = canvas.width * 0.85;
    let rectH = rectW / ratio;
    if (rectH > canvas.height * 0.85) {
      rectH = canvas.height * 0.85;
      rectW = rectH * ratio;
    }
    cropRect = new fabric.Rect({
      left: (canvas.width - rectW)/2,
      top: (canvas.height - rectH)/2,
      width: rectW,
      height: rectH,
      fill: 'rgba(0,0,0,0)',
      stroke: '#00A3FF',
      strokeWidth: 2,
      hasRotatingPoint: false,
      lockRotation: true,
      transparentCorners: false,
      cornerColor: '#00A3FF',
      cornerSize: 10
    });
    cropRect.setControlsVisibility({ mtr:false });
    canvas.add(cropRect);
    cropRect.bringToFront();

    // Outside area dim (gray)
    overlayFuncBound = () => {
      if (!cropRect) return;
      const r = cropRect.getBoundingRect();
      const ctx = canvas.getContext();
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.rect(0,0,canvas.width,canvas.height);
      ctx.moveTo(r.left, r.top);
      ctx.rect(r.left, r.top, r.width, r.height);
      ctx.fill('evenodd');
      ctx.restore();
    };
    canvas.on('after:render', overlayFuncBound);

    // Limit: image is not zoomable; cropRect is draggable only.
    cropRect.on('moving', constrainCropToImageBounds);
  }

  function constrainCropToImageBounds() {
    if (!baseImg || !cropRect) return;
    const imgRect = baseImg.getBoundingRect();
    const r = cropRect.getBoundingRect();
    let { left, top } = cropRect;

    // Keep crop within image bounds
    if (r.left < imgRect.left) left += (imgRect.left - r.left);
    if (r.top < imgRect.top) top += (imgRect.top - r.top);
    if (r.left + r.width > imgRect.left + imgRect.width) left -= (r.left + r.width - (imgRect.left + imgRect.width));
    if (r.top + r.height > imgRect.top + imgRect.height) top -= (r.top + r.height - (imgRect.top + imgRect.height));

    cropRect.set({ left, top });
    cropRect.setCoords();
  }

  function updateCropAspect() {
    if (!cropRect) return;
    const { wIn, hIn } = getDimsInInches();
    const ratio = (wIn && hIn) ? (wIn / hIn) : 1;

    const center = cropRect.getCenterPoint();
    let newW = cropRect.width;
    let newH = newW / ratio;
    if (newH > canvas.height * 0.9) {
      newH = canvas.height * 0.9;
      newW = newH * ratio;
    }
    cropRect.set({ width: newW, height: newH });
    cropRect.setPositionByOrigin(center, 'center', 'center');
    cropRect.setCoords();
    constrainCropToImageBounds();
    canvas.renderAll();
    drawPanelLines();
  }

  function updateAreaAndMin() {
    const { wIn, hIn } = getDimsInInches();
    const area = Math.max(0, inToFt2(wIn, hIn));
    $area.textContent = area.toFixed(2);
    const belowMin = area < minAreaFt2;
    $minwarn.hidden = !belowMin;
    $add.disabled = belowMin;
    return area;
  }

  function activeVariantPriceCents() {
    return varPriceMap[selectedVariantId] || 0;
  }

  function updatePriceView() {
    const area = updateAreaAndMin();
    const centsPerFt2 = activeVariantPriceCents();
    const totalCents = Math.round(centsPerFt2 * area);
    $total.textContent = formatMoney(totalCents);
  }

  function updateEverything() {
    updateCropAspect();
    updatePriceView();
    drawPanelLines();
  }

  // Panel lines (≤ panelMax, target panelTarget)
  function drawPanelLines() {
    // Clear old lines
    panelLines.forEach(l => canvas.remove(l));
    panelLines = [];
    if (!enablePanels || !$panelsToggle || !$panelsToggle.checked) {
      canvas.renderAll();
      return;
    }
    if (!cropRect) return;

    const { wIn } = getDimsInInches();
    if (wIn <= 0) return;

    // find number of panels n:
    let n = Math.max(1, Math.round(wIn / panelTarget));
    while (wIn / n > panelMax) n++;

    // If only 1 panel, nothing to draw
    if (n <= 1) { canvas.renderAll(); return; }

    // draw n-1 vertical lines over the cropRect
    const r = cropRect.getBoundingRect();
    for (let i = 1; i < n; i++) {
      const x = r.left + (r.width * (i / n));
      const line = new fabric.Line([x, r.top, x, r.top + r.height], {
        stroke: '#ffffff',
        strokeWidth: 2,
        selectable: false,
        evented: false
      });
      const lineShadow = new fabric.Line([x, r.top, x, r.top + r.height], {
        stroke: '#000000',
        strokeWidth: 1,
        selectable: false,
        evented: false
      });
      canvas.add(lineShadow);
      canvas.add(line);
      panelLines.push(lineShadow, line);
    }
    cropRect.bringToFront();
    canvas.renderAll();
  }

  function bindUI() {
    [$width, $height, $unit].forEach(el => {
      el.addEventListener('input', updateEverything);
      el.addEventListener('change', updateEverything);
    });
    $panelsToggle?.addEventListener('change', drawPanelLines);

    // Info popups (simple alerts here; you can replace with nicer modals)
    root.querySelectorAll('.ewz-info').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.info;
        if (t === 'measure') {
          alert('How to measure: Measure the widest and tallest parts of your wall. Add a small bleed if needed. Enter the final width/height here.');
        } else if (t === 'paper') {
          alert('Paper types: \n• Peel & Stick\n• Traditional Paste-the-Wall\n• Pre-pasted\n• Type II Vinyl\nChoose based on install needs and durability.');
        }
      });
    });

    // Defaults
    if (defaultUnit === 'cm') $unit.value = 'cm';
    $width.value = $width.value || (defaultUnit === 'cm' ? 244 : 96);
    $height.value = $height.value || (defaultUnit === 'cm' ? 244 : 96);

    $add.addEventListener('click', uploadAndAddToCart);
  }

  // Export cropped preview from the 2nd product image (client-side), upload to server to Save in Shopify Files
  async function exportCroppedBlob() {
    const imgScale = baseImg.getObjectScaling().scaleX; // uniform scale
    const imgLeft = baseImg.left;
    const imgTop = baseImg.top;

    const r = cropRect.getBoundingRect();
    const xOnCanvas = r.left - imgLeft;
    const yOnCanvas = r.top - imgTop;

    const sx = Math.max(0, Math.round(xOnCanvas / imgScale));
    const sy = Math.max(0, Math.round(yOnCanvas / imgScale));
    const sw = Math.round((r.width) / imgScale);
    const sh = Math.round((r.height) / imgScale);

    const src = await loadImage(baseImg.getSrc());
    const off = document.createElement('canvas');
    off.width = sw; off.height = sh;
    const ctx = off.getContext('2d');
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);

    return await new Promise((resolve) => off.toBlob(resolve, 'image/jpeg', 0.92));
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
  }

  async function uploadAndAddToCart() {
    const area = updateAreaAndMin();
    if (area < minAreaFt2) return;

    const blob = await exportCroppedBlob();
    const fd = new FormData();
    fd.append('file', blob, 'preview-crop.jpg');

    // include metadata
    const { wIn, hIn } = getDimsInInches();
    fd.append('width_in', String(wIn.toFixed(2)));
    fd.append('height_in', String(hIn.toFixed(2)));
    fd.append('product_handle', root.dataset.productHandle || '');
    fd.append('variant_id', selectedVariantId);

    // upload to server -> server saves in Shopify Files and returns URL
    const resp = await fetch(endpoint, { method: 'POST', body: fd });
    if (!resp.ok) {
      alert('Upload failed.');
      return;
    }
    const { url } = await resp.json();

    // quantity = area ft² (rounded up to next whole ft² so pricing matches your unit)
    const qty = Math.max(1, Math.ceil(area));
    const props = {
      _Crop_Image_URL: url,
      _Width_in: Number(wIn.toFixed(2)),
      _Height_in: Number(hIn.toFixed(2)),
      _Unit: $unit.value,
      _Area_ft2: Number(area.toFixed(2))
    };

    // Add to cart using selectedVariantId (paper type)
    const addResp = await fetch('/cart/add.js', {
      method:'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        id: Number(selectedVariantId),
        quantity: qty,
        properties: props
      })
    });
    if (!addResp.ok) {
      alert('Could not add to cart.');
      return;
    }
    closeModal();
    window.location.href = '/cart';
  }
})();
