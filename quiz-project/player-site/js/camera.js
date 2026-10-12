// Шаг 2: фото. Два равных способа: селфи с камеры или любое фото из галереи.
// Фото обязательно — без него кнопка «Продолжить» неактивна.
//
// Камера включается только по нажатию «Сделать селфи» (getUserMedia({ video: { facingMode: 'user' } })),
// чтобы тем, кто выбирает фото из галереи, браузер не задавал лишний вопрос про доступ к камере.
// Галерея — <input type="file" accept="image/*"> без capture: на Android так открывается выбор фото.
// Если камеры на странице нет (http://, старый браузер) — на телефоне открывается системная камера
// (<input capture="user">), а галерея доступна всегда.
// Любое фото → квадрат из центра 200×200 → JPEG, качество 0.7 (ниже, если больше 95 КБ).
import { flash, goTo, playerState } from './session.js';
import { showError, vibrate } from './ui.js';

const PHOTO_SIZE = 200;
const JPEG_QUALITY = 0.7;
const MAX_PHOTO_BYTES = 95 * 1024; // сервер принимает до 100 КБ, оставляем запас

const state = playerState.get();

const panel = document.getElementById('photo-panel');
const video = document.getElementById('video');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('placeholder');
const busy = document.getElementById('camera-busy');
const flashLayer = document.getElementById('flash');
const liveControls = document.getElementById('camera-live');
const shootButton = document.getElementById('shoot');
const cancelCameraButton = document.getElementById('cancel-camera');
const choices = document.getElementById('choices');
const selfieButton = document.getElementById('take-selfie');
const galleryChoice = document.getElementById('gallery-choice');
const captureInput = document.getElementById('capture-input');
const selfieLabel = document.getElementById('selfie-label');
const galleryLabel = document.getElementById('gallery-label');
const continueButton = document.getElementById('continue');
const error = document.getElementById('error');

let stream = null;
let photo = null;
let liveCameraFailed = false; // камера на странице не включилась — дальше селфи через системную камеру
let cameraRequest = 0; // защита от двойного нажатия и отмены во время запроса доступа

const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const canUseLiveCamera = () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

// ---------- Режимы экрана ----------

/**
 * empty — фото ещё нет, видны два способа; camera — включена камера; preview — фото выбрано.
 */
function setMode(mode) {
  panel.dataset.mode = mode;
  const live = mode === 'camera';
  liveControls.hidden = !live;
  choices.hidden = live;
  video.hidden = !live;
  preview.hidden = mode !== 'preview';
  placeholder.hidden = mode === 'preview' || (live && Boolean(video.videoWidth));
  continueButton.disabled = !photo || live;
  galleryChoice.classList.remove('is-suggested');
  // Когда фото уже есть, способы выбора становятся компактной строкой с короткими подписями.
  selfieLabel.textContent = mode === 'preview' ? 'Новое селфи' : 'Сделать селфи';
  galleryLabel.textContent = mode === 'preview' ? 'Из галереи' : 'Выбрать из галереи';
}

function setPhoto(dataUrl) {
  photo = dataUrl;
  preview.src = dataUrl;
  // Перезапуск анимации появления при повторном выборе.
  preview.classList.remove('is-new');
  void preview.offsetWidth;
  preview.classList.add('is-new');
  setMode('preview');
  showError(error, '');
}

function setBusy(isBusy) {
  busy.hidden = !isBusy;
  panel.setAttribute('aria-busy', String(isBusy));
}

/** Камера недоступна: объясняем почему и подсвечиваем галерею. */
function suggestGallery(message) {
  setMode(photo ? 'preview' : 'empty');
  showError(error, message);
  galleryChoice.classList.add('is-suggested');
}

// ---------- Сжатие ----------

function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Рисует квадратный центр источника на canvas 200×200 и возвращает JPEG data URL.
 * orientation — EXIF-ориентация, которую нужно применить вручную (только для старых браузеров).
 */
function compress(source, sourceWidth, sourceHeight, { mirror = false, orientation = 1 } = {}) {
  const side = Math.min(sourceWidth, sourceHeight);
  const sx = (sourceWidth - side) / 2;
  const sy = (sourceHeight - side) / 2;

  // Большие фото из галереи (4000×3000) уменьшаем в несколько шагов по половине — так края не «рвутся».
  let stage = null;
  let stageSide = side;
  while (stageSide > PHOTO_SIZE * 2) {
    const next = Math.max(PHOTO_SIZE * 2, Math.round(stageSide / 2));
    const canvas = document.createElement('canvas');
    canvas.width = next;
    canvas.height = next;
    const stageContext = canvas.getContext('2d');
    stageContext.imageSmoothingQuality = 'high';
    if (stage) stageContext.drawImage(stage, 0, 0, stageSide, stageSide, 0, 0, next, next);
    else stageContext.drawImage(source, sx, sy, side, side, 0, 0, next, next);
    stage = canvas;
    stageSide = next;
  }

  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff'; // у PNG с прозрачностью фон станет белым
  context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  applyOrientation(context, orientation);
  if (mirror) {
    // Фронтальная камера показывает зеркальную картинку — сохраняем так же, как человек видел себя.
    context.translate(PHOTO_SIZE, 0);
    context.scale(-1, 1);
  }
  if (stage) context.drawImage(stage, 0, 0, stageSide, stageSide, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  else context.drawImage(source, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);

  let quality = JPEG_QUALITY;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrlBytes(dataUrl) > MAX_PHOTO_BYTES && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('Браузер не смог сохранить фото. Попробуйте другое.');
  return dataUrl;
}

// ---------- EXIF-ориентация ----------
// Современные браузеры сами поворачивают фото по EXIF (CSS image-orientation: from-image).
// Для старых читаем тег Orientation из JPEG и поворачиваем квадрат вручную.

const browserAppliesExif = (() => {
  try {
    return CSS.supports('image-orientation', 'from-image');
  } catch {
    return false;
  }
})();

async function readExifOrientation(file) {
  try {
    const view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
        const tiff = offset + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const firstIfd = tiff + view.getUint32(tiff + 4, little);
        const entries = view.getUint16(firstIfd, little);
        for (let i = 0; i < entries; i += 1) {
          const entry = firstIfd + 2 + i * 12;
          if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little) || 1;
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      offset += 2 + size;
    }
  } catch {
    /* не JPEG или файл не читается — оставляем как есть */
  }
  return 1;
}

// Квадрат 200×200: повороты и отражения вокруг центра.
function applyOrientation(context, orientation) {
  const s = PHOTO_SIZE;
  switch (orientation) {
    case 2: context.transform(-1, 0, 0, 1, s, 0); break;
    case 3: context.transform(-1, 0, 0, -1, s, s); break;
    case 4: context.transform(1, 0, 0, -1, 0, s); break;
    case 5: context.transform(0, 1, 1, 0, 0, 0); break;
    case 6: context.transform(0, 1, -1, 0, s, 0); break;
    case 7: context.transform(0, -1, -1, 0, s, s); break;
    case 8: context.transform(0, -1, 1, 0, 0, s); break;
    default: break;
  }
}

// ---------- Камера на странице ----------

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Доступ к камере запрещён. Разрешите его в настройках браузера (значок замка в адресной строке) — или выберите фото из галереи.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Камера не найдена. Выберите фото из галереи.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Камера занята другим приложением. Закройте его и попробуйте ещё раз — или выберите фото из галереи.';
    default:
      return 'Не удалось включить камеру. Выберите фото из галереи.';
  }
}

async function startCamera() {
  const request = ++cameraRequest;
  showError(error, '');
  setMode('camera');
  shootButton.disabled = true;
  setBusy(true);
  try {
    const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    if (request !== cameraRequest) {
      // Пока браузер спрашивал разрешение, человек нажал «Отмена» или выбрал фото.
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    if (request !== cameraRequest) return;
    placeholder.hidden = true;
    shootButton.disabled = false;
    shootButton.focus({ preventScroll: true });
  } catch (err) {
    if (request !== cameraRequest) return;
    stopCamera();
    liveCameraFailed = true;
    suggestGallery(cameraErrorMessage(err));
  } finally {
    if (request === cameraRequest) setBusy(false);
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

function cancelCamera() {
  cameraRequest += 1;
  stopCamera();
  setBusy(false);
  setMode(photo ? 'preview' : 'empty');
}

function shoot() {
  if (!stream || !video.videoWidth) return;
  try {
    const dataUrl = compress(video, video.videoWidth, video.videoHeight, { mirror: true });
    flashLayer.classList.remove('is-active');
    void flashLayer.offsetWidth;
    flashLayer.classList.add('is-active');
    vibrate(40);
    cameraRequest += 1;
    stopCamera();
    setPhoto(dataUrl);
  } catch (err) {
    showError(error, err.message || 'Не удалось сделать снимок. Попробуйте ещё раз.');
  }
}

function onSelfieClick() {
  if (canUseLiveCamera() && !(liveCameraFailed && isTouchDevice)) {
    startCamera();
    return;
  }
  if (isTouchDevice) {
    // Камера на странице недоступна — открываем системную камеру телефона.
    captureInput.click();
    return;
  }
  suggestGallery(window.isSecureContext
    ? 'Этот браузер не поддерживает камеру. Выберите фото из галереи.'
    : 'Камера на странице работает только по защищённому адресу (https://). Выберите фото из галереи.');
}

// ---------- Фото из файла (галерея или системная камера) ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось открыть это фото. Выберите снимок в формате JPEG или PNG.'));
    };
    image.src = url;
  });
}

async function useFile(file) {
  // Некоторые галереи Android не сообщают тип файла — тогда просто пробуем открыть.
  if (file.type && !file.type.startsWith('image/')) {
    showError(error, 'Это не фотография. Выберите изображение.');
    return;
  }
  cameraRequest += 1;
  stopCamera();
  setBusy(true);
  try {
    const [image, orientation] = await Promise.all([
      loadImage(file),
      browserAppliesExif ? 1 : readExifOrientation(file),
    ]);
    setPhoto(compress(image, image.naturalWidth, image.naturalHeight, { orientation }));
    vibrate(20);
  } catch (err) {
    setMode(photo ? 'preview' : 'empty');
    showError(error, err.message || 'Не удалось обработать фото. Попробуйте другое.');
  } finally {
    setBusy(false);
  }
}

for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // чтобы можно было выбрать тот же файл ещё раз
    if (file) useFile(file);
  });
}

// ---------- Кнопки ----------

selfieButton.addEventListener('click', onSelfieClick);
shootButton.addEventListener('click', shoot);
cancelCameraButton.addEventListener('click', cancelCamera);

continueButton.addEventListener('click', () => {
  if (!photo) {
    showError(error, 'Сначала добавьте фото — без него войти нельзя.');
    return;
  }
  playerState.patch({ photo });
  if (playerState.get().photo !== photo) {
    showError(error, 'Не удалось сохранить фото в браузере. Отключите режим инкогнито и попробуйте ещё раз.');
    return;
  }
  cancelCamera();
  location.href = 'name.html';
});

window.addEventListener('pagehide', () => {
  cameraRequest += 1;
  stopCamera();
});
// Вернулись со страницы ника кнопкой «Назад» (bfcache) — камера уже выключена.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && panel.dataset.mode === 'camera') cancelCamera();
});

// ---------- Старт ----------

if (!state.code) {
  goTo('index.html', 'Сначала введите код комнаты');
} else {
  const message = flash.take();
  if (state.photo && !message) {
    setPhoto(state.photo);
  } else {
    setMode('empty');
    if (message) showError(error, message);
  }
}
