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

    const goFullscreen = () => {
        if (typeof tg.requestFullscreen === 'function') {
            try { tg.requestFullscreen(); } catch (e) { /* клиент не поддерживает */ }
        }
    };
    goFullscreen();
    setTimeout(goFullscreen, 250);

    if (versionAtLeast('8.0') || typeof tg.disableVerticalSwipes === 'function') {
        try { tg.disableVerticalSwipes(); } catch (e) { /* клиент не поддерживает */ }
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
    new: 'Не подключён',
};

const API = 'https://api.ozpay.ru:5001/api';
const devices = [];
const localChecks = new Map();
const serverBusy = new Set();

let activeFilter = 'all';
let pollTimer = null;

async function api(path, options = {}) {
    const response = await fetch(API + path, {
        ...options,
        mode: 'cors',
        credentials: 'omit',
        headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error('Сервер вернул не JSON');
    }
    if (!response.ok) {
        const detail = payload.detail;
        const message = Array.isArray(detail)
            ? detail.map((item) => item.msg || item).join(', ')
            : (detail || `${response.status} ${response.statusText}`);
        throw new Error(message);
    }
    return payload;
}

function checkingField(deviceId) {
    if (localChecks.has(deviceId)) return localChecks.get(deviceId);
    if (serverBusy.has(deviceId)) return 'all';
    return null;
}

function isChecking(deviceId, field) {
    const current = checkingField(deviceId);
    if (!current) return false;
    return field ? current === field || current === 'all' : true;
}

function checkingClass(deviceId) {
    return isChecking(deviceId) ? ' is-checking' : '';
}

function loadingClass(deviceId, field) {
    const current = checkingField(deviceId);
    if (!current) return '';
    if (current === 'all' || current === field) return ' is-loading';
    return '';
}

function busyClass(deviceId, field) {
    const current = checkingField(deviceId);
    if (current === field || current === 'all') return ' is-busy';
    return '';
}

function deviceIsBusy(item) {
    return Boolean(item && (item.checking || item.status === 'busy'));
}

function normalizeDevice(item) {
    return {
        ...item,
        cards: Array.isArray(item.cards) ? item.cards : [],
    };
}

function syncServerBusy(list) {
    serverBusy.clear();
    list.forEach((item) => {
        if (deviceIsBusy(item)) serverBusy.add(item.id);
    });
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function startPollingIfNeeded() {
    if (serverBusy.size === 0) {
        stopPolling();
        return;
    }
    if (pollTimer) return;
    pollTimer = setInterval(pollBusyDevices, 2000);
}

function refreshAll() {
    if (deviceScreen.classList.contains('screen--active')) {
        const detail = deviceScreen.querySelector('.detail');
        const id = detail && detail.dataset.id;
        const device = id && devices.find((item) => item.id === id);
        if (device) deviceScreen.innerHTML = renderDeviceScreen(device);
    }
    if (listScreen.classList.contains('screen--active')) {
        renderDevices();
    }
}

async function pollBusyDevices() {
    if (serverBusy.size === 0) {
        stopPolling();
        return;
    }
    try {
        const data = await api('/devices');
        if (!Array.isArray(data.devices)) return;
        const wasBusy = new Set(serverBusy);
        data.devices.forEach((item) => upsertDevice(normalizeDevice(item)));
        syncServerBusy(data.devices);
        const finished = [...wasBusy].filter((id) => !serverBusy.has(id) && !localChecks.has(id));
        refreshAll();
        if (finished.length) haptic.notify('success');
    } catch (error) {
        /* оставляем блокировку, пока сервер занят */
    }
    if (serverBusy.size === 0) stopPolling();
}

function upsertDevice(updated) {
    const index = devices.findIndex((item) => item.id === updated.id);
    if (index >= 0) devices[index] = updated;
    else devices.push(updated);
}

async function loadDevices() {
    const data = await api('/devices');
    if (!Array.isArray(data.devices)) {
        throw new Error('API не вернул список девайсов');
    }
    devices.splice(0, devices.length, ...data.devices.map(normalizeDevice));
    syncServerBusy(data.devices);
    renderDevices();
    startPollingIfNeeded();
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
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) {
        return '<span class="card-stack__empty">Карт нет</span>';
    }
    const shown = list.slice(0, 4).map((card) => `
        <span class="mini-card">${last4(card)}</span>
    `).join('');
    const rest = list.length - 4;
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
    const visible = devices.filter((d) => {
        if (activeFilter === 'all') return true;
        if (activeFilter === 'online') return d.status === 'online' || isChecking(d.id);
        return d.status === activeFilter;
    });
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
    const id = device.id;
    return `
        <div class="device device--${device.status}${checkingClass(id)}" data-id="${id}" style="animation-delay:${index * 45}ms">
            <div class="device__head">
                <div class="device__title">
                    <span class="device__name">${device.name}</span>
                    <span class="device__meta">
                        ${device.number}
                        <button class="copy-btn" data-copy="${device.number}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                </div>
                <button class="load-btn${busyClass(id, 'all')}" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
            </div>
            <div class="device__stats">
                <div class="tile${loadingClass(id, 'balance')}" data-field="balance">
                    <button class="load-btn load-btn--sm${busyClass(id, 'balance')}" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                    <b class="tile__value">${money(device.balance)}</b>
                    <span class="tile__label">баланс</span>
                </div>
                <div class="tile${loadingClass(id, 'turnover')}" data-field="turnover">
                    <button class="load-btn load-btn--sm${busyClass(id, 'turnover')}" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
                    <b class="tile__value">${money(turnover(device))}</b>
                    <span class="tile__label">оборот</span>
                </div>
            </div>
            <div class="tile tile--cards${loadingClass(id, 'cards')}" data-field="cards">
                <button class="load-btn load-btn--sm${busyClass(id, 'cards')}" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
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
    const number = card.number || '—';
    const expiry = card.expiry || '—';
    const cvv = card.cvv || '—';
    const numberRaw = (card.number || '').replace(/\s/g, '');
    return `
        <div class="card-row" data-number="${numberRaw}" data-expiry="${expiry}" data-cvv="${cvv}">
            <div class="card-row__preview">
                <span class="card-row__num">${number}</span>
                <span class="card-row__date">${expiry}</span>
                <span class="card-row__cvv">${cvv}</span>
            </div>
            <div class="card-row__expand">
                <button type="button" class="card-copy" data-copy="${numberRaw}" data-copy-msg="Номер скопирован">
                    <span>номер</span>
                    <b>${number}</b>
                    ${COPY_ICON}
                </button>
                <button type="button" class="card-copy" data-copy="${expiry}" data-copy-msg="Дата скопирована">
                    <span>дата</span>
                    <b>${expiry}</b>
                    ${COPY_ICON}
                </button>
                <button type="button" class="card-copy" data-copy="${cvv}" data-copy-msg="CVV скопирован">
                    <span>cvv</span>
                    <b>${cvv}</b>
                    ${COPY_ICON}
                </button>
            </div>
        </div>
    `;
}

const LOGIN_OFF_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a5 5 0 0 1 5 5v3"></path>
        <path d="M7 10V7a5 5 0 0 1 .5-2.2"></path>
        <rect x="4" y="10" width="16" height="11" rx="2.5"></rect>
        <path d="M3 3l18 18"></path>
    </svg>
`;

function deviceLabel(device) {
    return device.id || device.name || '—';
}

function renderDeviceSpecs(device) {
    return `
        <div class="spec-grid">
            <div class="spec-cell">
                <span>имя</span>
                <b>${deviceLabel(device)}</b>
            </div>
            <div class="spec-cell">
                <span>ip</span>
                <b>${device.ip || '—'}</b>
            </div>
            <div class="spec-cell">
                <span>порт</span>
                <b>${device.port || '—'}</b>
            </div>
        </div>
    `;
}

const TRASH_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h16"></path>
        <path d="M9 7V5h6v2"></path>
        <path d="M9 11v7M12 11v7M15 11v7"></path>
        <path d="M6 7l1 13h10l1-13"></path>
    </svg>
`;

function renderNewDeviceScreen(device) {
    return `
        <div class="detail device--${device.status}" data-id="${device.id}">
            <div class="detail__top">
                <button class="icon-btn" data-action="back" aria-label="Назад">${BACK_ICON}</button>
                <div class="detail__title-wrap">
                    <span class="detail__name">${deviceLabel(device)}</span>
                    <span class="detail__meta">
                        <i class="detail__dot"></i>${STATUS_LABEL[device.status] || device.status}
                    </span>
                </div>
                <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Удалить">${TRASH_ICON}</button>
            </div>
            ${renderDeviceSpecs(device)}
            <div class="login-state">
                <div class="login-state__icon">${LOGIN_OFF_ICON}</div>
                <p class="login-state__title">Вход в личный кабинет не выполнен</p>
                <button class="btn btn--primary login-state__btn" data-action="login">Добавить</button>
            </div>
        </div>
    `;
}

function renderDeviceScreen(device) {
    if (device.status === 'new' || device.linked === false) {
        return renderNewDeviceScreen(device);
    }
    const flowTotal = (device.income || 0) + (device.outcome || 0) || 1;
    const inShare = Math.round((device.income / flowTotal) * 100);

    return `
        <div class="detail device--${device.status}${checkingClass(device.id)}" data-id="${device.id}">
            <div class="detail__top">
                <button class="icon-btn" data-action="back" aria-label="Назад">${BACK_ICON}</button>
                <div class="detail__title-wrap">
                    <span class="detail__name">${deviceLabel(device)}</span>
                    <span class="detail__meta">
                        <i class="detail__dot"></i>${STATUS_LABEL[device.status] || device.status} · ${device.number}
                        <button class="copy-btn" data-copy="${device.number}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                </div>
                <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Удалить">${TRASH_ICON}</button>
                <button class="load-btn${busyClass(device.id, 'all')}" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
            </div>

            ${renderDeviceSpecs(device)}

            <div class="tile detail__balance${loadingClass(device.id, 'balance')}" data-field="balance">
                <button class="load-btn load-btn--sm${busyClass(device.id, 'balance')}" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                <span class="tile__label">баланс</span>
                <span class="detail__balance-value">${money(device.balance)}</span>
            </div>

            <div class="detail__flow${loadingClass(device.id, 'turnover')}" data-field="turnover">
                <div class="tile flow flow--in">
                    <b class="flow__value">+${money(device.income)}</b>
                    <span class="tile__label">приход</span>
                </div>
                <div class="tile flow flow--out">
                    <button class="load-btn load-btn--sm${busyClass(device.id, 'turnover')}" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
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
                <button class="load-btn load-btn--sm load-btn--inline${busyClass(device.id, 'cards')}" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
            </div>
            <div class="cards-full${loadingClass(device.id, 'cards')}" data-field="cards">
                ${(device.cards && device.cards.length) ? device.cards.map(renderCardFull).join('') : '<div class="empty">Карты не привязаны.</div>'}
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

function askDeleteDevice(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const label = device ? deviceLabel(device) : deviceId;
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Удалить девайс</h3>
        <p class="sheet__sub">${label} будет удалён из базы. Это нельзя отменить.</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--danger" data-action="confirm-delete">Удалить</button>
            <button type="button" class="btn" data-action="cancel">Отмена</button>
        </div>
    `);
    sheetContent.querySelector('[data-action="confirm-delete"]').addEventListener('click', () => {
        closeSheet();
        removeDevice(deviceId);
    });
    sheetContent.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
}

async function removeDevice(deviceId) {
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
        const index = devices.findIndex((item) => item.id === deviceId);
        if (index >= 0) devices.splice(index, 1);
        localChecks.delete(deviceId);
        serverBusy.delete(deviceId);
        haptic.notify('success');
        closeDevice();
        renderDevices();
        showToast('Девайс удалён');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось удалить');
    }
}

/* ---------- Проверка девайса ---------- */

function refreshView(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const detail = deviceScreen.querySelector('.detail');
    if (detail && deviceScreen.classList.contains('screen--active') && device) {
        deviceScreen.innerHTML = renderDeviceScreen(device);
    }
    if (listScreen.classList.contains('screen--active')) {
        renderDevices();
    }
}

async function checkDevice(rootEl, field) {
    const deviceId = rootEl.dataset.id;
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
    if (isChecking(deviceId)) return;

    localChecks.set(deviceId, field);
    refreshView(deviceId);
    haptic.impact('medium');

    try {
        const data = await api(`/devices/${encodeURIComponent(deviceId)}/check/${field}`, { method: 'POST' });
        if (!data.device) throw new Error('API не вернул девайс');
        upsertDevice(normalizeDevice(data.device));
        if (!deviceIsBusy(data.device)) serverBusy.delete(deviceId);
        haptic.notify('success');
    } catch (error) {
        if (String(error.message || '').includes('уже проверяется')) {
            serverBusy.add(deviceId);
            startPollingIfNeeded();
        } else {
            haptic.notify('error');
            showToast(error.message || 'Не удалось обновить');
        }
    } finally {
        localChecks.delete(deviceId);
        if (deviceIsBusy(devices.find((item) => item.id === deviceId))) {
            serverBusy.add(deviceId);
            startPollingIfNeeded();
        }
        refreshView(deviceId);
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
    stopLoginPoll();
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

    if (event.target.closest('[data-action="delete"]')) {
        askDeleteDevice(detail.dataset.id);
        return;
    }

    if (event.target.closest('[data-action="login"]')) {
        startLoginFlow(detail.dataset.id);
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

    const fieldCopy = event.target.closest('.card-copy');
    if (fieldCopy) {
        copyText(fieldCopy.dataset.copy, fieldCopy.dataset.copyMsg || 'Скопировано');
        return;
    }

    const cardEl = event.target.closest('.card-row');
    if (cardEl) {
        if (cardEl.dataset.hold === '1') {
            delete cardEl.dataset.hold;
            return;
        }
        if (cardEl.classList.contains('is-open')) return;
        collapseOpenCards();
        const text = [cardEl.dataset.number, cardEl.dataset.expiry, cardEl.dataset.cvv].join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        haptic.notify('success');
        showToast('Данные карты скопированы');
        return;
    }

    collapseOpenCards();
});

function collapseOpenCards(except) {
    deviceScreen.querySelectorAll('.card-row.is-open').forEach((el) => {
        if (el !== except) el.classList.remove('is-open');
    });
}

let cardHoldTimer = null;
let cardHoldTarget = null;
const CARD_HOLD_MS = 450;

function clearCardHold(moved) {
    if (cardHoldTimer) {
        clearTimeout(cardHoldTimer);
        cardHoldTimer = null;
    }
    if (moved) cardHoldTarget = null;
}

deviceScreen.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.card-row');
    if (!card || event.target.closest('.card-copy')) return;
    clearCardHold();
    cardHoldTarget = card;
    cardHoldTimer = setTimeout(() => {
        collapseOpenCards(card);
        card.classList.add('is-open');
        card.dataset.hold = '1';
        haptic.impact('medium');
        cardHoldTimer = null;
    }, CARD_HOLD_MS);
});

deviceScreen.addEventListener('pointerup', () => clearCardHold());
deviceScreen.addEventListener('pointercancel', () => clearCardHold(true));
deviceScreen.addEventListener('pointermove', (event) => {
    if (!cardHoldTarget || !cardHoldTimer) return;
    const card = event.target.closest('.card-row');
    if (card !== cardHoldTarget) clearCardHold(true);
});
deviceScreen.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.card-row')) event.preventDefault();
});
deviceScreen.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.card-row')) event.preventDefault();
});

document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-toast]');
    if (!el) return;
    haptic.notify('success');
    showToast(el.dataset.toast);
});

function normalizeIpInput(input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const next = input.value.replace(/,/g, '.');
    if (next === input.value) return;
    input.value = next;
    if (start != null) input.setSelectionRange(start, end);
}

function groupPhoneDigits(digits) {
    const d = digits.slice(0, 10);
    const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
    return parts.filter(Boolean).join(' ');
}

function formatPhoneInput(input) {
    const prevValue = input.value;
    const prevCaret = input.selectionStart != null ? input.selectionStart : prevValue.length;
    const digitsBeforeCaret = prevValue.slice(0, prevCaret).replace(/\D/g, '').length;

    let digits = prevValue.replace(/\D/g, '');
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
        digits = digits.slice(1);
    }
    digits = digits.slice(0, 10);

    const formatted = groupPhoneDigits(digits);
    input.value = formatted;

    let caret = 0;
    let seen = 0;
    while (caret < formatted.length && seen < digitsBeforeCaret) {
        if (/\d/.test(formatted[caret])) seen += 1;
        caret += 1;
    }
    if (input.setSelectionRange) input.setSelectionRange(caret, caret);
}

function openAddSheet() {
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Новый девайс</h3>
        <form class="form" id="addForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Имя девайса *</span>
                <input class="field__input" name="device" placeholder="device1 или redroid00" required>
            </label>
            <label class="field">
                <span class="field__label">IP *</span>
                <input class="field__input" name="ip" placeholder="192.168.0.10" inputmode="decimal" required>
            </label>
            <label class="field">
                <span class="field__label">Порт *</span>
                <input class="field__input" name="port" placeholder="5555" inputmode="numeric" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Сохранить</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `);

    const form = document.getElementById('addForm');
    form.addEventListener('submit', onAddSubmit);
    form.elements.ip.addEventListener('input', () => normalizeIpInput(form.elements.ip));
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    setTimeout(() => form.elements.device.focus(), 80);
}

async function onAddSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const device = form.elements.device.value.trim();
    if (!device) {
        showToast('Укажите имя девайса');
        return;
    }

    const payload = {
        id: device,
        ip: form.elements.ip.value.replace(/,/g, '.').trim(),
        port: form.elements.port.value.trim(),
    };
    if (!payload.ip || !payload.port) {
        showToast('Укажите IP и порт');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Проверяю ADB…';
    try {
        const data = await api('/devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!data.device) throw new Error('API не вернул девайс');
        upsertDevice(normalizeDevice(data.device));
        renderDevices();
        haptic.notify('success');
        closeSheet();
        showToast('Девайс добавлен');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось добавить');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Сохранить';
    }
}

/* ---------- Вход в личный кабинет (add_device) ---------- */

let loginPollTimer = null;
let loginShownStatus = null;

function stopLoginPoll() {
    if (loginPollTimer) {
        clearTimeout(loginPollTimer);
        loginPollTimer = null;
    }
}

function scheduleLoginPoll(deviceId, delay = 2000) {
    stopLoginPoll();
    loginPollTimer = setTimeout(() => tickLogin(deviceId), delay);
}

function renderLoginProgress(title, sub) {
    openSheet(`
        <h3 class="sheet__title">${title}</h3>
        <p class="sheet__sub">${sub}</p>
        <div class="login-progress"><span class="login-progress__spinner">${LOAD_ICON}</span></div>
    `);
}

function startLoginFlow(deviceId) {
    haptic.impact('medium');
    stopLoginPoll();
    loginShownStatus = null;
    openSheet(`
        <h3 class="sheet__title">Вход в личный кабинет</h3>
        <form class="form" id="loginForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Номер телефона *</span>
                <div class="field__phone">
                    <span class="field__prefix">+7</span>
                    <input class="field__input field__input--phone" name="number" placeholder="900 000 00 00" inputmode="numeric" autocomplete="tel-national" maxlength="13" required>
                </div>
            </label>
            <label class="field">
                <span class="field__label">Код-пароль *</span>
                <input class="field__input" name="password" placeholder="4 цифры" inputmode="numeric" autocomplete="off" maxlength="8" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Войти</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `);
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', (event) => onLoginSubmit(event, deviceId));
    form.elements.number.addEventListener('input', () => formatPhoneInput(form.elements.number));
    form.elements.password.addEventListener('input', () => {
        form.elements.password.value = form.elements.password.value.replace(/\D/g, '');
    });
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    setTimeout(() => form.elements.number.focus(), 80);
}

async function onLoginSubmit(event, deviceId) {
    event.preventDefault();
    const form = event.currentTarget;
    const number = form.elements.number.value.trim();
    const password = form.elements.password.value.trim();
    if (!number || !password) {
        showToast('Укажите номер и код-пароль');
        return;
    }

    loginShownStatus = 'running';
    renderLoginProgress('Выполняю вход…', 'Ввожу номер, жму «Войти», закрываю запрос доступа');
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number, password }),
        });
        scheduleLoginPoll(deviceId, 1200);
    } catch (error) {
        haptic.notify('error');
        renderLoginError(deviceId, error.message || 'Не удалось начать вход');
    }
}

async function tickLogin(deviceId) {
    let data;
    try {
        data = await api(`/devices/${encodeURIComponent(deviceId)}/login`);
    } catch (error) {
        scheduleLoginPoll(deviceId, 2500);
        return;
    }
    handleLoginStatus(deviceId, data);
}

function handleLoginStatus(deviceId, data) {
    switch (data.status) {
        case 'running':
            if (loginShownStatus !== 'running') {
                loginShownStatus = 'running';
                renderLoginProgress('Выполняю вход…', 'Ввожу номер, жму «Войти», закрываю запрос доступа');
            }
            scheduleLoginPoll(deviceId, 2000);
            break;
        case 'awaiting_code':
            if (loginShownStatus !== 'awaiting_code') {
                loginShownStatus = 'awaiting_code';
                haptic.notify('warning');
                renderCodeForm(deviceId, data);
            } else {
                updateCodeForm(data);
            }
            scheduleLoginPoll(deviceId, 2500);
            break;
        case 'verifying':
            if (loginShownStatus !== 'verifying') {
                loginShownStatus = 'verifying';
                renderLoginProgress('Проверяю код…', 'Ввожу код-пароль');
            }
            scheduleLoginPoll(deviceId, 2000);
            break;
        case 'done':
            stopLoginPoll();
            loginShownStatus = null;
            onLoginDone(deviceId, data.device);
            break;
        case 'error':
            stopLoginPoll();
            loginShownStatus = null;
            renderLoginError(deviceId, data.error);
            break;
        default:
            scheduleLoginPoll(deviceId, 2000);
    }
}

function codeHintText(info) {
    const target = info.target || '';
    if (info.method === 'call') {
        return `Вам поступает звонок${target ? ' на ' + target : ''}. Отвечать не нужно — введите последние 6 цифр входящего номера.`;
    }
    if (info.method === 'sms') {
        return `Код отправлен по СМС${target ? ' на ' + target : ''}. Введите 6 цифр из сообщения.`;
    }
    return `Введите 6-значный код${target ? ', отправленный на ' + target : ''}.`;
}

function renderCodeForm(deviceId, info) {
    openSheet(`
        <h3 class="sheet__title">Подтверждение входа</h3>
        <p class="sheet__sub" id="codeHint">${codeHintText(info)}</p>
        <form class="form" id="codeForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Код *</span>
                <input class="field__input" name="code" placeholder="6 цифр" inputmode="numeric" maxlength="6" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Подтвердить</button>
                <button type="button" class="btn btn--ghost" id="resendBtn" data-action="resend" disabled>Отправить код заново</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `);
    const form = document.getElementById('codeForm');
    form.addEventListener('submit', (event) => onCodeSubmit(event, deviceId));
    form.elements.code.addEventListener('input', () => {
        form.elements.code.value = form.elements.code.value.replace(/\D/g, '').slice(0, 6);
    });
    document.getElementById('resendBtn').addEventListener('click', () => onResend(deviceId));
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    updateCodeForm(info);
    setTimeout(() => form.elements.code.focus(), 80);
}

function updateCodeForm(info) {
    const hintEl = document.getElementById('codeHint');
    if (hintEl) hintEl.textContent = codeHintText(info);
    const resendBtn = document.getElementById('resendBtn');
    if (resendBtn && !resendBtn.dataset.sending) {
        resendBtn.disabled = !info.resend_available;
    }
}

async function onResend(deviceId) {
    const btn = document.getElementById('resendBtn');
    if (btn && btn.disabled) return;
    if (btn) {
        btn.dataset.sending = '1';
        btn.disabled = true;
        btn.textContent = 'Отправляю…';
    }
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login/resend`, { method: 'POST' });
        haptic.impact('medium');
        showToast('Запросил новый код');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось отправить');
    } finally {
        if (btn) {
            delete btn.dataset.sending;
            btn.textContent = 'Отправить код заново';
            btn.disabled = true;
        }
    }
}

async function onCodeSubmit(event, deviceId) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = form.elements.code.value.replace(/\D/g, '');
    if (code.length !== 6) {
        showToast('Нужно ввести 6 цифр');
        return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляю…';
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        loginShownStatus = 'verifying';
        renderLoginProgress('Проверяю код…', 'Ввожу код-пароль');
        scheduleLoginPoll(deviceId, 1500);
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось отправить код');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Подтвердить';
    }
}

function onLoginDone(deviceId, device) {
    if (device) upsertDevice(normalizeDevice(device));
    haptic.notify('success');
    closeSheet();
    const updated = devices.find((item) => item.id === deviceId);
    if (updated && deviceScreen.classList.contains('screen--active')) {
        deviceScreen.innerHTML = renderDeviceScreen(updated);
    }
    renderDevices();
    showToast('ЛК добавлен');
}

function renderLoginError(deviceId, message) {
    haptic.notify('error');
    openSheet(`
        <h3 class="sheet__title">Не удалось войти</h3>
        <p class="sheet__sub">${message || 'Ошибка входа'}</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--primary" data-action="retry">Повторить</button>
            <button type="button" class="btn" data-action="cancel">Закрыть</button>
        </div>
    `);
    sheetContent.querySelector('[data-action="retry"]').addEventListener('click', () => startLoginFlow(deviceId));
    sheetContent.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
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
