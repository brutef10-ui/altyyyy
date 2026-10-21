// Показ одноразовых кодов (резервный код): копирование и сохранение файлом.
// Код живёт только в памяти страницы; после ухода со страницы его больше нигде нет.
import { toast } from './ui.js';

/** Код группами: перенос строки возможен только между группами. */
export function renderCode(element, code) {
  const groups = code.split('-');
  element.replaceChildren(...groups.map((group, index) => {
    const span = document.createElement('span');
    span.textContent = index < groups.length - 1 ? `${group}-` : group;
    return span;
  }));
}

export async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast('Код скопирован');
  } catch {
    toast('Не получилось скопировать — выделите код и скопируйте вручную', 'error');
  }
}

export function downloadCode(login, code) {
  const text = `AL Studio — резервный код\nЛогин: ${login}\nКод: ${code}\n\nКод нужен, чтобы восстановить доступ, если вы забудете пароль. Он одноразовый: после восстановления вы получите новый.\nХраните его в надёжном месте.\n`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  link.download = `al-studio-${login}-backup-code.txt`;
  link.dataset.curtain = 'off';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
}

/** Контакт администратора: почта — ссылкой mailto, адрес https — обычной ссылкой, иначе текстом. */
export function contactNode(contact) {
  const value = String(contact || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const link = document.createElement('a');
    link.href = `mailto:${value}`;
    link.textContent = value;
    link.dataset.curtain = 'off';
    return link;
  }
  if (/^https:\/\/\S+$/.test(value)) {
    const link = document.createElement('a');
    link.href = value;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = value;
    return link;
  }
  return document.createTextNode(value);
}
