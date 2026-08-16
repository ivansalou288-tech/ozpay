const tg = window.Telegram ? window.Telegram.WebApp : null;

/* ---------- Telegram init: fullscreen + theme ---------- */

function versionAtLeast(target) {
    if (!tg || !tg.version) return false;
    const a = String(tg.version).split('.').map(Number);
    const b = target.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return true;
}

function applySafeArea() {
    const root = document.documentElement;
    const content = (tg && tg.contentSafeAreaInset) || {};
    const device = (tg && tg.safeAreaInset) || {};
    const top = (device.top || 0) + (content.top || 0);
    const bottom = (device.bottom || 0) + (content.bottom || 0);
    root.style.setProperty('--safe-top', top + 'px');
    root.style.setProperty('--safe-bottom', bottom + 'px');
}

function applyViewport() {
    const root = document.documentElement;
    const height = (tg && tg.viewportHeight) ? tg.viewportHeight : window.innerHeight;
    root.style.setProperty('--app-h', Math.round(height) + 'px');
    applySafeArea();
}

function initTelegram() {
    if (!tg) {
        document.documentElement.style.setProperty('--safe-top', '12px');
        applyViewport();
        window.addEventListener('resize', applyViewport);
        return;
    }

    tg.ready();
    tg.expand();

    if (versionAtLeast('8.0')) {
        try { tg.requestFullscreen(); } catch (e) { /* клиент не поддерживает */ }
        tg.disableVerticalSwipes();
        tg.onEvent('safeAreaChanged', applyViewport);
        tg.onEvent('contentSafeAreaChanged', applyViewport);
        tg.onEvent('fullscreenChanged', applyViewport);
    }

    tg.onEvent('viewportChanged', applyViewport);
    window.addEventListener('resize', applyViewport);

    if (versionAtLeast('6.1')) {
        tg.setHeaderColor('#08050f');
        tg.setBackgroundColor('#08050f');
    }
    if (versionAtLeast('7.10')) {
        tg.disableClosingConfirmation();
    }

    applyViewport();
}

/* ---------- Haptics ---------- */

const haptic = {
    impact(style = 'light') {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.impactOccurred(style);
        } else if (navigator.vibrate) {
            navigator.vibrate(style === 'heavy' ? 24 : style === 'medium' ? 14 : 8);
        }
    },
    notify(type = 'success') {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.notificationOccurred(type);
        } else if (navigator.vibrate) {
            navigator.vibrate([12, 40, 12]);
        }
    },
    select() {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.selectionChanged();
        } else if (navigator.vibrate) {
            navigator.vibrate(6);
        }
    },
};

const HAPTIC_SELECTOR = 'button, .device, .chip, .slot-add, .card-row, .copy-btn, [data-haptic]';

document.addEventListener('pointerdown', (event) => {
    const target = event.target.closest(HAPTIC_SELECTOR);
    if (!target) return;
    const style = target.dataset.haptic || 'light';
    if (style === 'select') haptic.select();
    else haptic.impact(style);
}, { passive: true });

/* ---------- Данные ---------- */

const STATUS_LABEL = {
    online: 'Доступен',
    busy: 'В работе',
    offline: 'Офлайн',
};

const API = 'https://api.ozpay.ru:5001/api';
const devices = [];

let activeFilter = 'all';

async function api(path, options = {}) {
    const response = await fetch(API + path, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = payload.detail;
        const message = Array.isArray(detail)
            ? detail.map((item) => item.msg || item).join(', ')
            : (detail || `${response.status} ${response.statusText}`);
        throw new Error(message);
    }
    return payload;
}

function upsertDevice(updated) {
    const index = devices.findIndex((item) => item.id === updated.id);
    if (index >= 0) devices[index] = updated;
    else devices.push(updated);
}

async function loadDevices() {
    const data = await api('/devices');
    devices.splice(0, devices.length, ...(data.devices || []));
    renderDevices();
}

const moneyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

function money(value) {
    return moneyFormat.format(value || 0) + ' ₽';
}

function turnover(device) {
    return device.outcome || 0;
}

function last4(card) {
    return (card.number || '').replace(/\s/g, '').slice(-4);
}

function renderCards(cards) {
    if (!cards.length) {
        return '<span class="card-stack__empty">Карт нет</span>';
    }
    const shown = cards.slice(0, 4).map((card) => `
        <span class="mini-card">${last4(card)}</span>
    `).join('');
    const rest = cards.length - 4;
    return shown + (rest > 0 ? `<span class="card-stack__more">+${rest}</span>` : '');
}

const LOAD_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
        <path d="M21 3v6h-6"></path>
    </svg>
`;

/* ---------- Рендер ---------- */

const deviceList = document.getElementById('deviceList');

function renderDevices() {
    const visible = devices.filter((d) => activeFilter === 'all' || d.status === activeFilter);
    document.getElementById('deviceCount').textContent = visible.length;

    if (!devices.length) {
        deviceList.innerHTML = '<div class="empty">В базе пока нет девайсов.</div>';
        return;
    }

    if (!visible.length) {
        deviceList.innerHTML = '<div class="empty">Нет девайсов в этой категории.</div>';
        return;
    }

    deviceList.innerHTML = visible.map((device, index) => renderDevice(device, index)).join('');
}

function renderDevice(device, index = 0) {
    return `
        <div class="device device--${device.status}" data-id="${device.id}" style="animation-delay:${index * 45}ms">
            <div class="device__head">
                <div class="device__title">
                    <span class="device__name">${device.name}</span>
                    <span class="device__meta">
                        ${device.number}
                        <button class="copy-btn" data-copy="${device.number}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                </div>
                <button class="load-btn" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
            </div>
            <div class="device__stats">
                <div class="tile" data-field="balance">
                    <button class="load-btn load-btn--sm" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                    <b class="tile__value">${money(device.balance)}</b>
                    <span class="tile__label">баланс</span>
                </div>
                <div class="tile" data-field="turnover">
                    <button class="load-btn load-btn--sm" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
                    <b class="tile__value">${money(turnover(device))}</b>
                    <span class="tile__label">оборот</span>
                </div>
            </div>
            <div class="tile tile--cards" data-field="cards">
                <button class="load-btn load-btn--sm" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
                <span class="tile__label">карты</span>
                <div class="card-stack">${renderCards(device.cards)}</div>
            </div>
        </div>
    `;
}

/* ---------- Экран управления девайсом ---------- */

const listScreen = document.getElementById('listScreen');
const deviceScreen = document.getElementById('deviceScreen');
const screensEl = document.querySelector('.screens');

const BACK_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 5l-7 7 7 7"></path>
    </svg>
`;

const COPY_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="11" height="13" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
`;

function renderCardFull(card) {
    return `
        <button class="card-row" data-number="${(card.number || '').replace(/\s/g, '')}" data-expiry="${card.expiry || ''}" data-cvv="${card.cvv || ''}">
            <span class="card-row__mark"></span>
            <span class="card-row__body">
                <span class="card-row__num">${card.number || '—'}</span>
                <span class="card-row__meta">${card.expiry || '—'} · ${card.cvv || '—'}</span>
            </span>
        </button>
    `;
}

function renderDeviceScreen(device) {
    const flowTotal = (device.income || 0) + (device.outcome || 0) || 1;
    const inShare = Math.round((device.income / flowTotal) * 100);

    return `
        <div class="detail device--${device.status}" data-id="${device.id}">
            <div class="detail__top">
                <button class="icon-btn" data-action="back" aria-label="Назад">${BACK_ICON}</button>
                <div class="detail__title-wrap">
                    <span class="detail__name">${device.name}</span>
                    <span class="detail__meta">
                        <i class="detail__dot"></i>${STATUS_LABEL[device.status]} · ${device.number}
                        <button class="copy-btn" data-copy="${device.number}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                </div>
                <button class="load-btn" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
            </div>

            <div class="tile detail__balance" data-field="balance">
                <button class="load-btn load-btn--sm" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                <span class="tile__label">баланс</span>
                <span class="detail__balance-value">${money(device.balance)}</span>
            </div>

            <div class="detail__flow" data-field="turnover">
                <div class="tile flow flow--in">
                    <b class="flow__value">+${money(device.income)}</b>
                    <span class="tile__label">приход</span>
                </div>
                <div class="tile flow flow--out">
                    <button class="load-btn load-btn--sm" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
                    <b class="flow__value">−${money(device.outcome)}</b>
                    <span class="tile__label">расход</span>
                </div>
            </div>

            <div class="flow-bar">
                <i style="width:${inShare}%"></i>
            </div>
            <div class="flow-legend">
                <span>оборот ${money(turnover(device))}</span>
                <span>приход ${inShare}%</span>
            </div>

            <div class="section-head">
                <h2 class="section-title">Карты</h2>
                <span class="section-count">${device.cards.length}</span>
                <button class="load-btn load-btn--sm load-btn--inline" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
            </div>
            <div class="cards-full" data-field="cards">
                ${device.cards.length ? device.cards.map(renderCardFull).join('') : '<div class="empty">Карты не привязаны.</div>'}
            </div>
        </div>
    `;
}

function openDevice(id) {
    const device = devices.find((d) => d.id === id);
    if (!device) return;

    deviceScreen.innerHTML = renderDeviceScreen(device);
    listScreen.classList.remove('screen--active');
    deviceScreen.classList.add('screen--active');
    screensEl.scrollTop = 0;
    haptic.impact('medium');

    if (tg && tg.BackButton) {
        tg.BackButton.show();
        tg.BackButton.onClick(closeDevice);
    }
}

function closeDevice() {
    deviceScreen.classList.remove('screen--active');
    listScreen.classList.add('screen--active');
    deviceScreen.innerHTML = '';
    screensEl.scrollTop = 0;

    if (tg && tg.BackButton) {
        tg.BackButton.hide();
        tg.BackButton.offClick(closeDevice);
    }
}

/* ---------- Проверка девайса ---------- */

const checking = new Set();

function refreshView(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const detail = deviceScreen.querySelector('.detail');
    if (detail && detail.dataset.id === deviceId && device) {
        deviceScreen.innerHTML = renderDeviceScreen(device);
        return;
    }
    renderDevices();
}

async function checkDevice(rootEl, field) {
    const device = devices.find((d) => d.id === rootEl.dataset.id);
    if (!device) return;
    const key = device.id + ':' + field;
    if (checking.has(key)) return;
    checking.add(key);

    const targets = field === 'all'
        ? [...rootEl.querySelectorAll('[data-field]')]
        : [...rootEl.querySelectorAll(`[data-field="${field}"]`)];

    targets.forEach((tile) => tile.classList.add('is-loading'));
    const loadBtn = rootEl.querySelector(`.load-btn[data-check="${field}"]`);
    if (loadBtn) loadBtn.classList.add('is-busy');
    rootEl.classList.add('is-checking');
    haptic.impact('medium');

    try {
        const data = await api(`/devices/${encodeURIComponent(device.id)}/check/${field}`, { method: 'POST' });
        upsertDevice(data.device);
        haptic.notify('success');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось обновить');
    } finally {
        checking.delete(key);
        refreshView(device.id);
    }
}

/* ---------- Toast ---------- */

const toastEl = document.getElementById('toast');
let toastTimer = null;

function copyText(text, toast) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    haptic.notify('success');
    showToast(toast);
}

function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-open'), 1900);
}

/* ---------- Bottom sheet ---------- */

const sheet = document.getElementById('sheet');
const sheetBackdrop = document.getElementById('sheetBackdrop');
const sheetContent = document.getElementById('sheetContent');

function openSheet(html) {
    sheetContent.innerHTML = html;
    sheet.classList.add('is-open');
    sheetBackdrop.classList.add('is-open');
    if (tg && tg.BackButton) {
        tg.BackButton.show();
        tg.BackButton.onClick(closeSheet);
    }
}

function closeSheet() {
    sheet.classList.remove('is-open');
    sheetBackdrop.classList.remove('is-open');
    if (tg && tg.BackButton) {
        tg.BackButton.hide();
        tg.BackButton.offClick(closeSheet);
    }
}

sheetBackdrop.addEventListener('click', () => {
    haptic.impact('light');
    closeSheet();
});

/* ---------- Клики ---------- */

document.getElementById('filterChips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('chip--active', c === chip));
    activeFilter = chip.dataset.filter;
    renderDevices();
});

deviceList.addEventListener('click', (event) => {
    const card = event.target.closest('.device');
    if (!card) return;

    const loadBtn = event.target.closest('.load-btn');
    if (loadBtn) {
        checkDevice(card, loadBtn.dataset.check);
        return;
    }

    const copyBtn = event.target.closest('.copy-btn');
    if (copyBtn) {
        copyText(copyBtn.dataset.copy, 'Номер скопирован');
        return;
    }

    openDevice(card.dataset.id);
});

deviceScreen.addEventListener('click', (event) => {
    const detail = event.target.closest('.detail');
    if (!detail) return;

    if (event.target.closest('[data-action="back"]')) {
        closeDevice();
        return;
    }

    const loadBtn = event.target.closest('.load-btn');
    if (loadBtn) {
        checkDevice(detail, loadBtn.dataset.check);
        return;
    }

    const copyBtn = event.target.closest('.copy-btn');
    if (copyBtn) {
        copyText(copyBtn.dataset.copy, 'Номер скопирован');
        return;
    }

    const cardEl = event.target.closest('.card-row');
    if (cardEl) {
        const text = [cardEl.dataset.number, cardEl.dataset.expiry, cardEl.dataset.cvv].join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        haptic.notify('success');
        showToast('Данные карты скопированы');
    }
});

document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-toast]');
    if (!el) return;
    haptic.notify('success');
    showToast(el.dataset.toast);
});

function openAddSheet() {
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Добавить девайс</h3>
        <p class="sheet__sub">Тестовый режим — подключение по ADB появится позже.</p>
        <div class="sheet__grid">
            <div class="sheet__cell"><b>ADB</b><span>по ip:port</span></div>
            <div class="sheet__cell"><b>QR</b><span>сопряжение</span></div>
        </div>
        <div class="sheet__actions">
            <button class="btn btn--primary" data-toast="Слот зарезервирован" data-haptic="medium">Занять слот</button>
        </div>
    `);
}

document.getElementById('addDeviceBtn').addEventListener('click', openAddSheet);
document.getElementById('slotAdd').addEventListener('click', openAddSheet);
document.getElementById('statsBtn').addEventListener('click', () => showToast('Статистика скоро'));
document.getElementById('settingsBtn').addEventListener('click', () => showToast('Настройки скоро'));

/* ---------- Старт ---------- */

initTelegram();
loadDevices().catch((error) => {
    deviceList.innerHTML = `<div class="empty">Не удалось загрузить девайсы.<br>${error.message}</div>`;
});
