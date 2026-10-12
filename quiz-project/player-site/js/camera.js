// Шаг 2: селфи. Фото обязательно — без снимка кнопка «Продолжить» неактивна.
// Камера: getUserMedia({ video: { facingMode: 'user' } }). Снимок → canvas 200×200 → JPEG, качество 0.7.
// Если камера недоступна — запасной вариант <input type="file" accept="image/*" capture="user">.
import { flash, goTo, playerState } from './session.js';
import { showError, vibrate } from './ui.js';

const PHOTO_SIZE = 200;
const JPEG_QUALITY = 0.7;
const MAX_PHOTO_BYTES = 95 * 1024; // сервер принимает до 100 КБ, оставляем запас

const state = playerState.get();

const video = document.getElementById('video');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('placeholder');
const flashLayer = document.getElementById('flash');
const shootButton = document.getElementById('shoot');
const retakeButton = document.getElementById('retake');
const fileLabel = document.getElementById('file-label');
const fileInput = document.getElementById('file');
const continueButton = document.getElementById('continue');
const error = document.getElementById('error');

let stream = null;
let photo = null;
let cameraFailed = false;

// ---------- Сжатие ----------

function dataUrlBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4);
}

/** Рисует квадратный центр источника на canvas 200×200 и возвращает JPEG data URL. */
function compress(source, sourceWidth, sourceHeight, { mirror = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const context = canvas.getContext('2d');
  const side = Math.min(sourceWidth, sourceHeight);
  const sx = (sourceWidth - side) / 2;
  const sy = (sourceHeight - side) / 2;

  context.fillStyle = '#ffffff'; // у PNG с прозрачностью фон станет белым
  context.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  if (mirror) {
    // Фронтальная камера показывает зеркальную картинку — сохраняем так же, как человек видел себя.
    context.translate(PHOTO_SIZE, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);

  let quality = JPEG_QUALITY;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrlBytes(dataUrl) > MAX_PHOTO_BYTES && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('Браузер не смог сохранить фото');
  return dataUrl;
}

// ---------- Отображение ----------

function setPhoto(dataUrl) {
  photo = dataUrl;
  preview.src = dataUrl;
  preview.hidden = false;
  video.hidden = true;
  placeholder.hidden = true;
  shootButton.hidden = true;
  retakeButton.hidden = false;
  fileLabel.hidden = !cameraFailed;
  continueButton.disabled = false;
  showError(error, '');
}

function clearPhoto() {
  photo = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  continueButton.disabled = true;
  retakeButton.hidden = true;
}

// ---------- Камера ----------

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Доступ к камере запрещён. Разрешите его в настройках браузера (значок замка в адресной строке) и обновите страницу — или загрузите фото.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'Камера не найдена. Загрузите фото с устройства.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Камера занята другим приложением. Закройте его и обновите страницу — или загрузите фото.';
    default:
      return 'Не удалось включить камеру. Загрузите фото с устройства.';
  }
}

function showFileFallback(message) {
  cameraFailed = true;
  stopCamera();
  showError(error, message);
  video.hidden = true;
  placeholder.hidden = Boolean(photo);
  shootButton.hidden = true;
  fileLabel.hidden = false;
}

async function startCamera() {
  clearPhoto();
  if (!window.isSecureContext) {
    showFileFallback('Камера работает только по защищённому адресу (https://). Загрузите фото с устройства.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showFileFallback('Этот браузер не поддерживает камеру. Загрузите фото с устройства.');
    return;
  }

  shootButton.hidden = false;
  shootButton.disabled = true;
  placeholder.hidden = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    video.hidden = false;
    placeholder.hidden = true;
    shootButton.disabled = false;
    showError(error, '');
  } catch (err) {
    showFileFallback(cameraErrorMessage(err));
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
}

function shoot() {
  if (!stream || !video.videoWidth) return;
  try {
    const dataUrl = compress(video, video.videoWidth, video.videoHeight, { mirror: true });
    flashLayer.classList.remove('is-active');
    void flashLayer.offsetWidth;
    flashLayer.classList.add('is-active');
    vibrate(40);
    stopCamera();
    setPhoto(dataUrl);
  } catch (err) {
    showError(error, err.message || 'Не удалось сделать снимок. Попробуйте ещё раз.');
  }
}

// ---------- Загрузка из файла ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось открыть изображение. Выберите фото в формате JPEG или PNG.'));
    };
    image.src = url;
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError(error, 'Выберите файл с фотографией.');
    return;
  }
  try {
    const image = await loadImage(file);
    setPhoto(compress(image, image.naturalWidth, image.naturalHeight));
  } catch (err) {
    showError(error, err.message);
  }
});

// ---------- Кнопки ----------

shootButton.addEventListener('click', shoot);

retakeButton.addEventListener('click', () => {
  if (cameraFailed) {
    fileInput.click();
    return;
  }
  startCamera();
});

continueButton.addEventListener('click', () => {
  if (!photo) {
    showError(error, 'Сначала сделайте селфи — без фото войти нельзя.');
    return;
  }
  playerState.patch({ photo });
  if (playerState.get().photo !== photo) {
    showError(error, 'Не удалось сохранить фото в браузере. Отключите режим инкогнито и попробуйте ещё раз.');
    return;
  }
  stopCamera();
  location.href = 'name.html';
});

window.addEventListener('pagehide', stopCamera);

// ---------- Старт ----------

if (!state.code) {
  goTo('index.html', 'Сначала введите код комнаты');
} else {
  const message = flash.take();
  if (state.photo && !message) {
    setPhoto(state.photo);
  } else {
    startCamera().then(() => {
      if (message) showError(error, message);
    });
  }
}
