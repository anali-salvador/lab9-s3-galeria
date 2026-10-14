// Galería en S3 — frontend sin credenciales de AWS.
// El backend firma las URLs; el navegador sube y descarga directo desde S3.
const API_URL = ''; // mismo origen que el servidor Express

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  preview: $('preview'),
  previewImg: $('preview-img'),
  previewName: $('preview-name'),
  previewSize: $('preview-size'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  progressText: $('progress-text'),
  uploadBtn: $('upload-btn'),
  cancelBtn: $('cancel-btn'),
  refreshBtn: $('refresh-btn'),
  retryBtn: $('retry-btn'),
  gallery: $('gallery'),
  empty: $('empty'),
  loadError: $('load-error'),
  loadErrorText: $('load-error-text'),
  count: $('image-count'),
  countLabel: $('image-count-label'),
  lightbox: $('lightbox'),
  lightboxImg: $('lightbox-img'),
  lightboxCaption: $('lightbox-caption'),
  confirm: $('confirm'),
  confirmText: $('confirm-text'),
  confirmOk: $('confirm-ok'),
  confirmCancel: $('confirm-cancel'),
  toasts: $('toasts'),
  confetti: $('confetti'),
};

let selectedFile = null;
let previewUrl = null;
let uploading = false;

// ---------- Utilidades ----------
function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const dateFormat = new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' });

// "originales/1760450000000-a1b2c3d4-mi-foto.jpg" -> "mi-foto.jpg"
function displayName(key) {
  return key.replace(/^originales\//, '').replace(/^\d{10,}-[0-9a-f]{8}-/, '');
}

function shorten(name, max = 26) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${name.slice(0, max - ext.length - 1)}…${ext}`;
}

function icon(name) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function setButton(btn, iconName, text, { spin = false } = {}) {
  btn.replaceChildren(icon(iconName), document.createTextNode(` ${text}`));
  renderIcons();
  if (spin) btn.querySelector('svg')?.classList.add('spin');
}

async function readError(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

// ---------- Notificaciones ----------
function toast(message, type = 'info') {
  const iconName = { success: 'circle-check', error: 'circle-alert', info: 'info' }[type];
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'toast__icon';
  iconWrap.append(icon(iconName));
  const text = document.createElement('p');
  text.className = 'toast__text';
  text.textContent = message;

  el.append(iconWrap, text);
  els.toasts.append(el);
  renderIcons();

  setTimeout(() => {
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600); // por si no hay animaciones
  }, type === 'error' ? 6000 : 4000);
}

// ---------- Confeti (animado solo con CSS) ----------
function confetti() {
  if (REDUCED_MOTION.matches) return;
  const colors = ['#FFB3C7', '#FFC9A3', '#FFE699', '#B8F0C8', '#B3E5FC', '#D4C1FF'];
  const pieces = [];
  for (let n = 0; n < 40; n++) {
    const s = document.createElement('span');
    s.style.setProperty('--x', `${Math.random() * 100}vw`);
    s.style.setProperty('--c', colors[n % colors.length]);
    s.style.setProperty('--drift', `${(Math.random() - 0.5) * 220}px`);
    s.style.setProperty('--r', `${(Math.random() - 0.5) * 900}deg`);
    s.style.setProperty('--d', `${1.6 + Math.random() * 1.2}s`);
    s.style.setProperty('--delay', `${Math.random() * 0.35}s`);
    pieces.push(s);
  }
  els.confetti.append(...pieces);
  setTimeout(() => pieces.forEach((p) => p.remove()), 3400);
}

// ---------- Selección de archivo ----------
function validateFile(file) {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return 'Formato no permitido. Elige una imagen JPG, PNG o WebP.';
  }
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > MAX_BYTES) {
    return `La imagen pesa ${formatBytes(file.size)}. El máximo es 5 MB.`;
  }
  return null;
}

function selectFile(file) {
  if (!file || uploading) return;
  const error = validateFile(file);
  if (error) {
    toast(error, 'error');
    els.fileInput.value = '';
    return;
  }

  selectedFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);

  els.previewImg.src = previewUrl;
  els.previewName.textContent = file.name;
  els.previewName.title = file.name;
  els.previewSize.textContent = `${formatBytes(file.size)} · ${file.type.replace('image/', '').toUpperCase()}`;
  els.progress.hidden = true;
  els.uploadBtn.disabled = false;
  els.preview.hidden = false;
}

function resetSelection() {
  selectedFile = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  els.fileInput.value = '';
  els.preview.hidden = true;
  els.progress.hidden = true;
  setProgress(0);
}

function setProgress(pct) {
  els.progressBar.style.width = `${pct}%`;
  els.progressText.textContent = `${pct}%`;
  els.progressBar.parentElement.setAttribute('aria-valuenow', String(pct));
}

// ---------- Subida ----------
function putToS3(url, file, headers) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 403) reject(new Error('S3 rechazó la subida (403). La URL pudo haber caducado o la firma no coincide.'));
      else reject(new Error(`S3 respondió con el código ${xhr.status}.`));
    });
    xhr.addEventListener('error', () => {
      reject(new Error('No se pudo conectar con S3. Revisa la configuración CORS del bucket.'));
    });
    xhr.send(file);
  });
}

async function uploadSelected() {
  if (!selectedFile || uploading) return;
  const file = selectedFile;
  const error = validateFile(file);
  if (error) return toast(error, 'error');

  uploading = true;
  els.uploadBtn.disabled = true;
  els.cancelBtn.disabled = true;
  setButton(els.uploadBtn, 'loader-circle', 'Subiendo…', { spin: true });
  els.progress.hidden = false;
  setProgress(0);

  try {
    const res = await fetch(`${API_URL}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
    });
    if (!res.ok) throw new Error(await readError(res, 'No se pudo preparar la subida.'));
    const { uploadUrl, headers } = await res.json();

    await putToS3(uploadUrl, file, headers || { 'Content-Type': file.type });

    setProgress(100);
    toast(`¡Listo! "${shorten(file.name, 30)}" ya está en tu galería.`, 'success');
    confetti();
    resetSelection();
    await loadImages();
  } catch (err) {
    toast(err.message || 'Algo salió mal al subir la imagen.', 'error');
  } finally {
    uploading = false;
    els.uploadBtn.disabled = !selectedFile;
    els.cancelBtn.disabled = false;
    setButton(els.uploadBtn, 'cloud-upload', 'Subir');
  }
}

// ---------- Galería ----------
function updateCount(n) {
  els.count.textContent = String(n);
  els.countLabel.textContent = n === 1 ? 'imagen' : 'imágenes';
}

function showSkeletons(n = 6) {
  els.gallery.setAttribute('aria-busy', 'true');
  els.empty.hidden = true;
  els.loadError.hidden = true;
  els.gallery.replaceChildren(
    ...Array.from({ length: n }, () => {
      const card = document.createElement('div');
      card.className = 'card card--skeleton';
      card.setAttribute('aria-hidden', 'true');
      card.innerHTML = `
        <div class="card__band"></div>
        <div class="skeleton skeleton--media"></div>
        <div class="card__body">
          <div class="skeleton skeleton--line"></div>
          <div class="skeleton skeleton--short"></div>
        </div>`;
      return card;
    })
  );
}

function createCard(image, index) {
  const name = displayName(image.key);

  const card = document.createElement('article');
  card.className = 'card';
  card.style.setProperty('--i', String(Math.min(index, 12)));

  const band = document.createElement('div');
  band.className = 'card__band';

  const media = document.createElement('div');
  media.className = 'card__media';
  const img = document.createElement('img');
  img.src = image.url;
  img.alt = name;
  img.loading = 'lazy';
  media.append(img);
  media.addEventListener('click', () => openLightbox(image.url, name));

  const body = document.createElement('div');
  body.className = 'card__body';

  const title = document.createElement('h3');
  title.className = 'card__name';
  title.textContent = shorten(name);
  title.title = name;

  const meta = document.createElement('p');
  meta.className = 'card__meta';
  const size = document.createElement('span');
  size.textContent = formatBytes(image.size);
  const date = document.createElement('span');
  date.textContent = dateFormat.format(new Date(image.lastModified));
  meta.append(size, date);

  const actions = document.createElement('div');
  actions.className = 'card__actions';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn btn--lila';
  viewBtn.append(icon('expand'), document.createTextNode(' Ver'));
  viewBtn.setAttribute('aria-label', `Ver ${name} en grande`);
  viewBtn.addEventListener('click', () => openLightbox(image.url, name));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--rosa';
  delBtn.append(icon('trash-2'), document.createTextNode(' Eliminar'));
  delBtn.setAttribute('aria-label', `Eliminar ${name}`);
  delBtn.addEventListener('click', () => askDelete(image.key, name, card));

  actions.append(viewBtn, delBtn);
  body.append(title, meta, actions);
  card.append(band, media, body);
  return card;
}

function renderGallery(images) {
  els.gallery.setAttribute('aria-busy', 'false');
  updateCount(images.length);
  els.loadError.hidden = true;

  if (images.length === 0) {
    els.gallery.replaceChildren();
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.gallery.replaceChildren(...images.map(createCard));
  renderIcons();
}

async function loadImages({ skeleton = false } = {}) {
  if (skeleton) showSkeletons();
  els.refreshBtn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/api/images`);
    if (!res.ok) throw new Error(await readError(res, 'No se pudo cargar la galería.'));
    const data = await res.json();
    renderGallery(data.images || []);
  } catch (err) {
    els.gallery.setAttribute('aria-busy', 'false');
    els.gallery.replaceChildren();
    els.empty.hidden = true;
    els.loadErrorText.textContent =
      err instanceof TypeError ? 'No hay conexión con el servidor. ¿Está encendido?' : err.message;
    els.loadError.hidden = false;
    toast(els.loadErrorText.textContent, 'error');
  } finally {
    els.refreshBtn.disabled = false;
  }
}

// ---------- Vista ampliada ----------
function openLightbox(url, name) {
  els.lightboxImg.src = url;
  els.lightboxImg.alt = name;
  els.lightboxCaption.textContent = name;
  els.lightbox.showModal();
}

els.lightbox.addEventListener('click', (e) => {
  // clic en el fondo (fuera del contenido) o en el botón de cerrar
  if (e.target === els.lightbox || e.target.closest('[data-close]')) els.lightbox.close();
});
els.lightbox.addEventListener('close', () => {
  els.lightboxImg.removeAttribute('src');
});

// ---------- Eliminar ----------
function confirmDialog(name) {
  els.confirmText.textContent = `"${shorten(name, 40)}" se borrará de S3 y no se puede deshacer.`;
  els.confirm.showModal();
  els.confirmCancel.focus();

  return new Promise((resolve) => {
    const finish = (value) => {
      els.confirmOk.removeEventListener('click', onOk);
      els.confirmCancel.removeEventListener('click', onCancel);
      els.confirm.removeEventListener('close', onClose);
      if (els.confirm.open) els.confirm.close();
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false); // tecla Esc
    els.confirmOk.addEventListener('click', onOk);
    els.confirmCancel.addEventListener('click', onCancel);
    els.confirm.addEventListener('close', onClose);
  });
}

els.confirm.addEventListener('click', (e) => {
  if (e.target === els.confirm) els.confirm.close();
});

async function askDelete(key, name, card) {
  const ok = await confirmDialog(name);
  if (!ok) return;

  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const res = await fetch(`${API_URL}/api/images/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readError(res, 'No se pudo eliminar la imagen.'));

    card.classList.add('is-removing');
    setTimeout(() => {
      card.remove();
      const remaining = els.gallery.querySelectorAll('.card:not(.card--skeleton)').length;
      updateCount(remaining);
      if (remaining === 0) els.empty.hidden = false;
    }, REDUCED_MOTION.matches ? 0 : 380);
    toast(`"${shorten(name, 30)}" se eliminó.`, 'success');
  } catch (err) {
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    toast(err.message, 'error');
  }
}

// ---------- Eventos de la zona de carga ----------
els.fileInput.addEventListener('change', () => selectFile(els.fileInput.files[0]));

els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});

['dragenter', 'dragover'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-dragover');
  })
);
['dragleave', 'dragend', 'drop'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => {
    if (type === 'dragleave' && els.dropzone.contains(e.relatedTarget)) return;
    els.dropzone.classList.remove('is-dragover');
  })
);
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  if (files.length > 1) toast('Se tomará solo la primera imagen. Súbelas de una en una.', 'info');
  selectFile(files[0]);
});

// Evita que el navegador abra la imagen si se suelta fuera de la zona.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

els.uploadBtn.addEventListener('click', uploadSelected);
els.cancelBtn.addEventListener('click', resetSelection);
els.refreshBtn.addEventListener('click', () => loadImages({ skeleton: true }));
els.retryBtn.addEventListener('click', () => loadImages({ skeleton: true }));

// ---------- Inicio ----------
renderIcons();
loadImages({ skeleton: true });
